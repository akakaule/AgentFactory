import type { DB } from '../db.js';
import type { TaskDetail, Status, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export function updateStatus(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso, actorUserId: number | null = null, note?: string): TaskDetail {
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
  // Kind gating (the TRANSITIONS table has no kind axis): a 'pr-review' task is born straight into
  // review and is never implemented, so the backlog→in_review edge is pr-review-only, and a
  // pr-review task can't be queued for an agent to "implement" a teammate's PR.
  if (row.status === 'backlog' && status === 'in_review' && row.kind !== 'pr-review')
    throw new ValidationError(`only a pr-review task can move straight to review (got kind '${row.kind}')`);
  if (row.status === 'backlog' && status === 'queued' && row.kind === 'pr-review')
    throw new ValidationError('a pr-review task is reviewed, not implemented — move it to in_review');
  assertTransition(row.status, status, actor);
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, status, ts);
    // `note` rides in the status_change body — e.g. an agent's reason when moving to `blocked`.
    // The drawer surfaces it as the focused block reason; empty when omitted (legacy behavior).
    appendActivity(db, { taskId: row.id, type: 'status_change', actor, fromStatus: row.status, toStatus: status, body: note?.trim() || '', createdAt: ts, actorUserId });
    // Releasing a stranded claim (in_progress → queued by a human) abandons the worker — end its
    // orphaned live session so it clears from the Live view immediately, even if the dispatcher
    // that would normally reap it is down. Idempotent (the dispatcher's reap also calls this).
    if (row.status === 'in_progress' && status === 'queued' && actor === 'human') endSession(db, row.id, ts);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
