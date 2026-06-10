import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function reviewApprove(db: DB, key: string, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, 'done', 'human');
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, 'done', ts);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: row.status, toStatus: 'done', createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
