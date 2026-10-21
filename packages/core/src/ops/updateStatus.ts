import type { DB } from '../db.js';
import type { TaskDetail, Status, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import { reconcileMergedDelivery } from './delivery.js';
import { deliveryRowFor } from '../repo/delivery.js';
import { advanceRetryBudget } from '../repo/retry.js';

export function updateStatus(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso, actorUserId: number | null = null, note?: string): TaskDetail {
  const requestedFrom = findRowByKey(db, key)?.status;
  return transaction(db, () => updateStatusWithinTransaction(db, key, status, actor, now, actorUserId, note, requestedFrom));
}

/**
 * The caller must hold a write transaction, so related audit writes commit atomically.
 * `requestedFrom` is the status the caller saw before opening the transaction (defaults to the
 * current one), letting a stale human retry detect a repair the watcher completed meanwhile.
 */
export function updateStatusWithinTransaction(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso, actorUserId: number | null = null, note?: string, requestedFrom?: Status): TaskDetail {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    // archived tasks are immutable for state — without this, done → queued would reopen
    // a task the board no longer shows
    if (row.archived_at !== null)
      throw new InvalidTransitionError(`an archived task cannot change status — unarchive it first: ${key}`);
    // a doc-stage review closes via the approve action (which advances the stage and
    // re-queues) — a raw status move to done would skip the stage machine entirely
    if (row.status === 'in_review' && status === 'done' && row.stage !== 'implementation')
      throw new InvalidTransitionError(`a ${row.stage}-stage review is approved via the approve action, not a status move`);
    // Kind gating (the TRANSITIONS table has no kind axis): a 'pr-review' task is reviewed and never
    // implemented, so it must NEVER enter the worker queue — from backlog, a send-back, or a reopen.
    // (The dispatcher would otherwise claim it and spawn a worker to "implement" a teammate's PR.)
    if (status === 'queued' && row.kind === 'pr-review')
      throw new ValidationError('a pr-review task is reviewed, not implemented — it cannot be queued (move it to in_review)');
    // The straight-into-review edges (born from backlog, rescued from a stray queue, reopened from
    // done) are pr-review-only — a 'code' task can never skip implementation by jumping to review.
    if (status === 'in_review' && row.kind !== 'pr-review' && (row.status === 'backlog' || row.status === 'queued' || row.status === 'done'))
      throw new ValidationError(`only a pr-review task moves straight to review (got kind '${row.kind}')`);
    // The agent in_review → queued edge exists solely for the doc-stage auto-approve
    // (ops/approval.ts) — as a raw status move it would let an agent dodge its own review.
    if (row.status === 'in_review' && status === 'queued' && actor === 'agent')
      throw new InvalidTransitionError('an agent cannot send a review back to the queue — reviews close via the approve/request-changes actions');
    if (status === 'done' && actor === 'agent')
      throw new InvalidTransitionError('agent completion requires delivery reconciliation, not a raw status move');
    // A retry already in flight must not reopen a repair that the watcher just completed.
    if (status === 'queued' && actor === 'human' && (requestedFrom ?? row.status) !== 'done' && row.status === 'done'
      && deliveryRowFor(db, row.id)?.pr_state === 'merged') return toDetail(db, row);
    assertTransition(row.status, status, actor);
    const ts = now();
    // Pulling an approved delivery back explicitly starts new work, as does reopening done.
    if (status === 'queued' && actor === 'human' && (row.status === 'delivering' || row.status === 'done'))
      db.prepare('DELETE FROM task_delivery WHERE task_id = ?').run(row.id);
    if ((status === 'queued' || status === 'in_progress') && reconcileMergedDelivery(db, row, ts))
      return toDetail(db, findRowByKey(db, key)!);
    setStatus(db, row.id, status, ts);
    // `note` rides in the status_change body — e.g. an agent's reason when moving to `blocked`.
    // The drawer surfaces it as the focused block reason; empty when omitted (legacy behavior).
    appendActivity(db, { taskId: row.id, type: 'status_change', actor, fromStatus: row.status, toStatus: status, body: note?.trim() || '', createdAt: ts, actorUserId });
    // Releasing a stranded claim (in_progress → queued by a human) abandons the worker — end its
    // orphaned live session so it clears from the Live view immediately, even if the dispatcher
    // that would normally reap it is down. Idempotent (the dispatcher's reap also calls this).
    if (row.status === 'in_progress' && status === 'queued' && actor === 'human') endSession(db, row.id, ts);
    // A human unblocking or reopening a task hands the worker new work, not another retry of the
    // rounds that ended there — without a fresh budget the dispatcher silently skips it. (Releasing
    // a stranded claim above is still a retry and keeps counting.)
    if (status === 'queued' && actor === 'human' && (row.status === 'blocked' || row.status === 'done'))
      advanceRetryBudget(db, row.id, `dispatcher:${row.stage}`, ts, 'human re-queue');
    return toDetail(db, findRowByKey(db, key)!);
}
