import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, aiReviewFor } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function reviewApprove(db: DB, key: string, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, 'done', 'human');
  return transaction(db, () => {
    const ts = now();
    // Break-glass audit trail: approving while the *current* AI review has open findings
    // logs an override comment. Derived, no schema change; the override-rate KPI reads the
    // same condition from the activity log (findingsAtApproval). Pending/clean ⇒ no override.
    const review = aiReviewFor(db, row.id);
    if (review && review.verdict === 'findings') {
      appendActivity(db, {
        taskId: row.id, type: 'comment', actor: 'human',
        body: `override: approved over ${review.findings} open AI finding${review.findings === 1 ? '' : 's'}`,
        createdAt: ts,
      });
    }
    setStatus(db, row.id, 'done', ts);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: row.status, toStatus: 'done', createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
