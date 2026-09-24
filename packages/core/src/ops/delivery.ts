import type { DB } from '../db.js';
import type { TaskDetail, DeliverySummary, DeliveryProvider } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, touch, type TaskRow } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { latestPrLinkUrl } from '../repo/links.js';
import { deliveryRowFor, updateDeliveryObservation, upsertDelivery, toDeliverySummary, type DeliveryObservation } from '../repo/delivery.js';
import { buildFailureComment } from '../failure.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow, advanceRetryBudget } from '../repo/retry.js';

const DEFAULT_DELIVERY_REPAIR_ATTEMPTS = 2;

/** The watcher's reasons for bouncing a delivering task back to the queue. */
export type DeliveryFailureReason = 'ci_failed' | 'pr_closed' | 'merge_conflict';

// The watcher (its own process) races the web server's human overrides on these rows, so unlike
// the single-process ops the status read happens INSIDE the BEGIN IMMEDIATE transaction.
function requireRow(db: DB, key: string) {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return row;
}

/** The delivery state for one task (or null) — rides TaskDetail; exposed for the watcher too. */
export function getDelivery(db: DB, key: string): DeliverySummary | null {
  const row = requireRow(db, key);
  const d = deliveryRowFor(db, row.id);
  return d ? toDeliverySummary(d) : null;
}

/**
 * Seed a delivery row for a task already in 'delivering' that has none — the watcher's self-heal
 * for a raw in_review → delivering drag (approve seeds it in-transaction; a drag bypasses that).
 */
export function beginDelivery(db: DB, key: string, seed: { provider: DeliveryProvider; branch: string; prUrl?: string | null }, now: () => string = nowIso): DeliverySummary {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.status !== 'delivering') throw new ValidationError(`beginDelivery requires status 'delivering' (got ${row.status})`);
    upsertDelivery(db, row.id, { provider: seed.provider, branch: seed.branch, prUrl: seed.prUrl ?? null }, now());
    return toDeliverySummary(deliveryRowFor(db, row.id)!);
  });
}

/**
 * Record one watcher poll. Always refreshes checked_at; bumps the task (→ getVersion → UI refetch)
 * only when the observed PR/checks state actually changed. A confirmed merge also completes
 * the current delivery in this transaction, including during repair. Terminal/archived tasks and stale
 * observations are ignored so a slow provider response cannot overwrite a newer delivery.
 */
export function recordDeliveryCheck(db: DB, key: string, obs: DeliveryObservation, now: () => string = nowIso): { changed: boolean; skipped?: boolean; accepted: boolean; stateChangedAt: string | null } {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.archived_at || !['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status)) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const d = deliveryRowFor(db, row.id);
    if (!d) return { changed: false, skipped: true, accepted: false, stateChangedAt: null }; // nothing seeded
    const expected = obs.expected;
    if (expected && (expected.status !== row.status || expected.branch !== d.branch ||
        expected.prUrl !== d.pr_url || expected.stateChangedAt !== d.state_changed_at)) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const ts = now();
    const { changed, accepted } = updateDeliveryObservation(db, d, obs, ts);
    if (!accepted) return { changed: false, skipped: true, accepted: false, stateChangedAt: null };
    const stateChangedAt = changed ? ts : d.state_changed_at;
    if (reconcileMergedDelivery(db, row, ts)) return { changed: true, accepted, stateChangedAt };
    if (changed) touch(db, row.id, ts);
    return { changed, accepted, stateChangedAt };
  });
}

/**
 * Finish a previously observed merged delivery. The stored facts, not a caller's note, authorize
 * completion. Used to recover legacy queued deliveries before dispatching another worker.
 */
export function completeDelivery(db: DB, key: string, note: string, expectedStateChangedAt?: string, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (expectedStateChangedAt !== undefined && deliveryRowFor(db, row.id)?.state_changed_at !== expectedStateChangedAt)
      throw new InvalidTransitionError(`stale delivery observation for ${key}`);
    if (!reconcileMergedDelivery(db, row, now(), note))
      throw new InvalidTransitionError(`completion requires a current merged delivery: ${key}`);
    return toDetail(db, findRowByKey(db, key)!);
  });
}

/** Runs inside the caller's transaction (observation, retry, or claim); never nests a transaction. */
export function reconcileMergedDelivery(db: DB, row: TaskRow, ts: string, note?: string): boolean {
  if (row.archived_at || row.kind !== 'code' || row.stage !== 'implementation' ||
      !['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status)) return false;
  const d = deliveryRowFor(db, row.id);
  if (!d || d.pr_state !== 'merged' || !d.pr_url || !d.checked_at || d.branch !== row.branch) return false;
  // A repair may already have submitted a replacement PR, pending its own approval.
  const latestPr = latestPrLinkUrl(db, row.id);
  if (latestPr && latestPr !== d.pr_url) return false;
  assertTransition(row.status, 'done', 'agent');
  setStatus(db, row.id, 'done', ts);
  endSession(db, row.id, ts);
  const body = `PR ${d.pr_id ?? d.pr_url} merged; checks ${d.checks_state}. Original delivery complete; further CI repair is separate work.`;
  appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status,
    toStatus: 'done', body: note ? `${body}\n${note}` : body, createdAt: ts });
  return true;
}

/**
 * The watcher's bounce: CI failed, the PR was closed unmerged, or the PR cannot merge cleanly
 * ⇒ one transaction posting a `failure/v1` comment (reason ci_failed | pr_closed |
 * merge_conflict — rendered by the existing failure chip, carried into the next claim payload so
 * the fixing session reads why) AND re-queuing the task.
 * Comment + requeue must not tear: a requeue without the why (or the why without the requeue)
 * would strand the next agent/human without context.
 */
export function failDelivery(
  db: DB,
  key: string,
  input: { reason: DeliveryFailureReason; detail: string; body?: string | undefined; expectedStateChangedAt?: string | undefined },
  now: () => string = nowIso,
): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.status !== 'delivering') throw new InvalidTransitionError(`delivery failure requires delivering (got ${row.status})`);
    assertTransition(row.status, 'queued', 'agent');
    if (input.expectedStateChangedAt !== undefined && deliveryRowFor(db, row.id)?.state_changed_at !== input.expectedStateChangedAt)
      throw new InvalidTransitionError(`stale delivery observation for ${key}`);
    const ts = now();
    const repair = reserveRetryRow(db, row.id, key, { operation: 'delivery', maxAttempts: DEFAULT_DELIVERY_REPAIR_ATTEMPTS }, ts);
    if (!repair) throw new InvalidTransitionError(`delivery repair budget exhausted for ${key}; operator restart is required`);
    const comment = buildFailureComment({
      reason: input.reason, detail: input.detail, source: 'watcher', attempt: repair.attempt, maxAttempts: repair.maxAttempts,
      ...(input.body !== undefined ? { body: input.body } : {}),
    });
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: comment, createdAt: ts });
    setStatus(db, row.id, 'queued', ts); // clears the claimant like every path into 'queued'
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status, toStatus: 'queued', body: input.detail, createdAt: ts });
    settleRetryRow(db, repair.id, 'failed', ts, input.detail);
    // The repair is new work (merge main, fix CI), not a retry of the earlier implementation
    // rounds — without a fresh worker budget the dispatcher silently skips it. The delivery
    // budget above bounds how often this can happen; its final bounce is left for a human.
    if (repair.attempt < repair.maxAttempts) advanceRetryBudget(db, row.id, `dispatcher:${row.stage}`, ts, 'delivery repair');
    return toDetail(db, findRowByKey(db, key)!);
  });
}
