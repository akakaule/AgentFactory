import type { DB } from '../db.js';
import type { TaskDetail, DeliverySummary, DeliveryProvider } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, touch } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { deliveryRowFor, updateDeliveryObservation, upsertDelivery, toDeliverySummary, type DeliveryObservation } from '../repo/delivery.js';
import { buildFailureComment } from '../failure.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

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
 * only when the observed PR/checks state actually changed. Deliberately a no-op once the task has
 * left 'delivering' — a late watcher write races a human override, and the human wins.
 */
export function recordDeliveryCheck(db: DB, key: string, obs: DeliveryObservation, now: () => string = nowIso): { changed: boolean } {
  return transaction(db, () => {
    const row = requireRow(db, key);
    if (row.status !== 'delivering') return { changed: false };
    const d = deliveryRowFor(db, row.id);
    if (!d) return { changed: false }; // nothing seeded — the watcher self-heals via beginDelivery first
    const ts = now();
    const { changed } = updateDeliveryObservation(db, d, obs, ts);
    if (changed) touch(db, row.id, ts);
    return { changed };
  });
}

/**
 * The watcher's happy ending: PR merged + pipeline green ⇒ delivering → done (by 'agent' — the
 * one automated path into done, and it exists only from delivering). `note` records WHY in the
 * status trail (e.g. "PR #42 merged; checks green"). Throws InvalidTransitionError if the task
 * already left delivering (raced a human) — callers treat that as settled, not an error.
 */
export function completeDelivery(db: DB, key: string, note: string, now: () => string = nowIso): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    assertTransition(row.status, 'done', 'agent');
    const ts = now();
    setStatus(db, row.id, 'done', ts);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status, toStatus: 'done', body: note, createdAt: ts });
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
  input: { reason: DeliveryFailureReason; detail: string; body?: string | undefined },
  now: () => string = nowIso,
): TaskDetail {
  return transaction(db, () => {
    const row = requireRow(db, key);
    assertTransition(row.status, 'queued', 'agent');
    const ts = now();
    const comment = buildFailureComment({ reason: input.reason, detail: input.detail, source: 'watcher', ...(input.body !== undefined ? { body: input.body } : {}) });
    appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: comment, createdAt: ts });
    setStatus(db, row.id, 'queued', ts); // clears the claimant like every path into 'queued'
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: row.status, toStatus: 'queued', body: input.detail, createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
