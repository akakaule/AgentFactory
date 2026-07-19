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
 * owning supervisor follows the derived failure state — makes it forget the task's burned attempts
 * and retry with a fresh budget, so no supervisor bounce is needed.
 *
 * Dispatcher failures remain `queued`; reviewer failures remain `in_review` (or `delivering` for
 * feedback evaluation). Restart is status-preserving and only accepts a current skip-listed state.
 */
export function restartTask(db: DB, key: string, actorUserId: number | null = null, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  const current = toDetail(db, row);
  const failure = current.failure;
  const dispatcherRetry = row.status === 'queued' && failure?.skipListed === true;
  const reviewerRetry = failure?.source === 'reviewer' && failure.skipListed &&
    (row.status === 'in_review' || row.status === 'delivering');
  if (!dispatcherRetry && !reviewerRetry) {
    throw new InvalidTransitionError(
      `restart requires a current skip-listed supervisor failure in queued, in_review, or delivering (got ${row.status})`,
    );
  }
  return transaction(db, () => {
    const ts = now();
    appendActivity(db, {
      taskId: row.id,
      type: 'comment',
      actor: 'human',
      body: buildRestartComment('operator restarted — attempt budget reset; the supervisor will retry'),
      createdAt: ts,
      actorUserId,
    });
    touch(db, row.id, ts); // bump updated_at so getVersion() moves and clients/dispatcher refetch
    return toDetail(db, findRowByKey(db, key)!);
  });
}
