import type { DB } from '../db.js';
import type { TaskDetail, Status, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function updateStatus(db: DB, key: string, status: Status, actor: Actor, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, status, actor);
  return transaction(db, () => {
    const ts = now();
    setStatus(db, row.id, status, ts);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor, fromStatus: row.status, toStatus: status, createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
