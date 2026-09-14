import type { DB } from '../db.js';
import type { TaskDetail, Status, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import { assertExecutionOwnership } from '../repo/execution.js';

export function updateStatus(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso, actorUserId: number | null = null, note?: string, executionId?: string): TaskDetail {
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    if (actor === 'agent') assertExecutionOwnership(db, row.id, key, executionId, { requireRunning: true });
    // archived tasks are immutable for state — without this, done → queued would reopen
    // a task the board no longer shows
    if (row.archived_at !== null)
      throw new InvalidTransitionError(`an archived task cannot change status — unarchive it first: ${key}`);
    // a doc-stage review closes via the approve action (which advances the stage and
    // re-queues) — a raw status move to done would skip the stage machine entirely
    if (row.status === 'in_review' && status === 'done' && row.stage !== 'implementation')
      throw new InvalidTransitionError(`a ${row.stage}-stage review is approved via the approve action, not a status move`);
    if (status === 'queued' && row.kind === 'pr-review')
      throw new ValidationError('a pr-review task is reviewed, not implemented — it cannot be queued (move it to in_review)');
    if (status === 'in_review' && row.kind !== 'pr-review' && (row.status === 'backlog' || row.status === 'queued' || row.status === 'done'))
      throw new ValidationError(`only a pr-review task moves straight to review (got kind '${row.kind}')`);
    if (row.status === 'in_review' && status === 'queued' && actor === 'agent')
      throw new InvalidTransitionError('an agent cannot send a review back to the queue — reviews close via the approve/request-changes actions');
    assertTransition(row.status, status, actor);
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
