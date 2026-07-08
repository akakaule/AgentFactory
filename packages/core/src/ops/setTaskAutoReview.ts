import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, setAutoReview, toDetail } from '../repo/tasks.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export function setTaskAutoReview(db: DB, key: string, enabled: boolean, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (enabled && row.kind === 'pr-review') {
    throw new ValidationError('a pr-review task has no worker queue to auto-iterate');
  }
  return transaction(db, () => {
    setAutoReview(db, row.id, enabled, now());
    return toDetail(db, findRowByKey(db, key)!);
  });
}
