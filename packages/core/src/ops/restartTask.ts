import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail, touch } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { buildRestartComment } from '../failure.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Operator "restart" for a stuck (skip-listed) task: post a `restart/v1` marker that supersedes
 * the task's latest failure note. That both clears the board's skip-list chip and — because the
 * dispatcher follows the derived failure state — makes the running dispatcher forget the task's
 * burned attempts and retry it with a fresh budget, so no supervisor bounce is needed.
 *
 * Valid only on a `queued` task: a skip-listed task always sits `queued` (the dispatcher leaves
 * it there for a human). The other statuses have their own recovery edges — Unblock (blocked),
 * Reopen (done), Release claim (in_progress), Re-queue (delivering) — so restart stays narrow.
 */
export function restartTask(db: DB, key: string, actorUserId: number | null = null, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'queued')
    throw new InvalidTransitionError(`restart requires a queued task (got ${row.status}) — a skip-listed task sits queued; other states have their own recovery action`);
  return transaction(db, () => {
    const ts = now();
    appendActivity(db, {
      taskId: row.id,
      type: 'comment',
      actor: 'human',
      body: buildRestartComment('operator restarted — attempt budget reset; the dispatcher will retry'),
      createdAt: ts,
      actorUserId,
    });
    touch(db, row.id, ts); // bump updated_at so getVersion() moves and clients/dispatcher refetch
    return toDetail(db, findRowByKey(db, key)!);
  });
}
