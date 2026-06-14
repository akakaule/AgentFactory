import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { applyApproval } from './approval.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Human approval of an in_review task. Stage-aware: doc stages advance and re-queue,
 * the implementation stage closes the task — see applyApproval for the shared body.
 */
export function reviewApprove(db: DB, key: string, now: () => string = nowIso, actorUserId: number | null = null): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`approve requires in_review (got ${row.status})`);
  return transaction(db, () => {
    applyApproval(db, row, 'human', now(), undefined, actorUserId);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
