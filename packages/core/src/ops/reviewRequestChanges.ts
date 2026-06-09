import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { transaction } from '../transaction.js';
import { feedbackSchema, parse } from '../validate.js';
import { findRowByKey, toTask, setStatus } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { linksFor } from '../repo/links.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

export function reviewRequestChanges(db: DB, key: string, input: { feedback: string }, now: () => string = nowIso): TaskDetail {
  const { feedback } = parse(feedbackSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`request changes requires in_review (got ${row.status})`);
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, 'queued', ts);
    appendActivity(db, { taskId: row.id, type: 'feedback', actor: 'human', body: feedback, createdAt: ts });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: 'in_review', toStatus: 'queued', createdAt: ts });
    const fresh = findRowByKey(db, key)!;
    return { ...toTask(fresh), activity: recentActivity(db, row.id, RECENT_ACTIVITY_LIMIT), links: linksFor(db, row.id) };
  });
}
