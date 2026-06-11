import type { DB } from '../db.js';
import { findRowByKey, deleteRowById } from '../repo/tasks.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';

/** Human-only hard delete. An in_progress task is protected — release the claim first. */
export function deleteTask(db: DB, key: string): void {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status === 'in_progress')
    throw new InvalidTransitionError(`cannot delete an in_progress task — release the claim first: ${key}`);
  deleteRowById(db, row.id);
}
