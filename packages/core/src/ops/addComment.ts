import type { DB } from '../db.js';
import type { Activity, Actor } from '../types.js';
import { transaction } from '../transaction.js';
import { commentSchema, parse } from '../validate.js';
import { findRowByKey, touch } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function addComment(
  db: DB,
  key: string,
  input: { actor: Actor; body: string },
  now: () => string = nowIso,
): Activity {
  const { body } = parse(commentSchema, { body: input.body });
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return transaction(db, () => {
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'comment', actor: input.actor, body, createdAt: ts });
    touch(db, row.id, ts);
    const recent = recentActivity(db, row.id, 1);
    return recent[0]!;
  });
}
