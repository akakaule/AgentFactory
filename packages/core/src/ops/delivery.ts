import type { DB } from '../db.js';
import type { TaskDetail, DeliverySummary, DeliveryProvider } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, touch, type TaskRow } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { deliveryRowFor, updateDeliveryObservation, upsertDelivery, toDeliverySummary, type DeliveryObservation, type DeliveryRow } from '../repo/delivery.js';
import { buildFailureComment } from '../failure.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow } from '../repo/retry.js';
import { endSession } from '../repo/agentSessions.js';

const DEFAULT_DELIVERY_REPAIR_ATTEMPTS = 2;

/** The watcher's reasons for bouncing a delivering task back to the queue. */
export type DeliveryFailureReason = 'ci_failed' | 'pr_closed' | 'merge_conflict';

function mergedChecksNote(delivery: DeliveryRow): string {
  const checks = delivery.checks_state === 'passing'
    ? 'green'
    : delivery.checks_state === 'none'
      ? 'not configured'
      : `${delivery.checks_state}; merge resolved the original task (CI status retained)`;
  return `PR ${delivery.pr_id ?? delivery.pr_url ?? 'current'} merged; checks ${checks}`;
}

/** Complete a delivery while the caller already holds the core write transaction. */
export function completeDeliveryRow(db: DB, row: TaskRow, delivery: DeliveryRow, ts: string, note = mergedChecksNote(delivery)): void {
  setStatus(db, row.id, 'done', ts);
  endSession(db, row.id, ts);
  appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status, toStatus: 'done', body: note, createdAt: ts });
}

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
 * only when the observed PR/checks state actually changed. Deliberately a no-op once the task has
 * left the active approval episode — a late watcher write races a human override or a new
 * submission, and the newer lifecycle wins. The watcher may use this to refresh facts while a
 * queued/blocked/in-progress repair is waiting for reconciliation.
 */
export function recordDeliveryCheck(db: DB, key: string, obs: DeliveryObservation, now: () => string = nowIso): { changed: boolean; accepted: boolean; stateChangedAt: string | null } {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (!['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status)) return { changed: false, accepted: false, stateChangedAt: null };
    const d = deliveryRowFor(db, row.id);
    if (!d) return { changed: false, accepted: false, stateChangedAt: null }; // nothing seeded — the watcher self-heals via beginDelivery first
    const ts = now();
    const { changed, accepted } = updateDeliveryObservation(db, d, obs, ts);
    if (changed) touch(db, row.id, ts);
    return { changed, accepted, stateChangedAt: accepted ? (changed ? ts : d.state_changed_at) : null };
  });
}

/**
 * The watcher's happy ending: a current approved PR was merged ⇒ the task is done (by 'agent').
 * This also reconciles queued or active repairs of that delivery; the host's check state remains
 * in the delivery row and in the note. An episode token prevents a slow observation from
 * completing a replacement delivery.
 */
export function completeDelivery(db: DB, key: string, note: string, expectedStateChangedAt?: string, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (!['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(row.status))
      throw new InvalidTransitionError(`${row.status} -> done not allowed for agent`);
    const delivery = deliveryRowFor(db, row.id);
    if (!delivery || (expectedStateChangedAt !== undefined && delivery.state_changed_at !== expectedStateChangedAt))
      throw new InvalidTransitionError(`stale delivery observation for ${key}`);
    const ts = now();
    completeDeliveryRow(db, row, delivery, ts, note);
    return toDetail(db, findRowByKey(db, key)!);
  });
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
    assertTransition(row.status, 'queued', 'agent');
    const delivery = deliveryRowFor(db, row.id);
    if (input.expectedStateChangedAt !== undefined && delivery?.state_changed_at !== input.expectedStateChangedAt)
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
    return toDetail(db, findRowByKey(db, key)!);
  });
}
