import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { findRowByKey, toTask } from '../repo/tasks.js';
import { recentActivity } from '../repo/activity.js';
import { linksFor } from '../repo/links.js';
import { NotFoundError } from '../errors.js';

export function getTask(db: DB, key: string): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  const task = toTask(row);
  return { ...task, activity: recentActivity(db, row.id, RECENT_ACTIVITY_LIMIT), links: linksFor(db, row.id) };
}
