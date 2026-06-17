import type { DB } from '../db.js';
import type { TaskDetail, Status, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

export function updateStatus(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso, actorUserId: number | null = null): TaskDetail {
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
  assertTransition(row.status, status, actor);
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, status, ts);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor, fromStatus: row.status, toStatus: status, createdAt: ts, actorUserId });
    // Releasing a stranded claim (in_progress → queued by a human) abandons the worker — end its
    // orphaned live session so it clears from the Live view immediately, even if the dispatcher
    // that would normally reap it is down. Idempotent (the dispatcher's reap also calls this).
    if (row.status === 'in_progress' && status === 'queued' && actor === 'human') endSession(db, row.id, ts);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
