import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { NotFoundError } from '../errors.js';

export function getTask(db: DB, key: string): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return toDetail(db, row);
}
