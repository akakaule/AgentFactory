import type { DB } from '../db.js';
import type { Task, UpdateTaskInput } from '../types.js';
import { transaction } from '../transaction.js';
import { updateTaskSchema, parse } from '../validate.js';
import { findRowByKey, findByKey, applyEdit } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

export function updateTask(db: DB, key: string, input: UpdateTaskInput, now: () => string = nowIso): Task {
  const fields = parse(updateTaskSchema, input) as UpdateTaskInput;
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    if (row.status !== 'backlog') throw new InvalidTransitionError(`only backlog tasks are editable (got ${row.status})`);
    const workspaceId = fields.workspace === undefined
      ? undefined
      : requireWorkspaceByName(db, fields.workspace).id;
    const ts = now();
    applyEdit(db, row.id, fields, ts, workspaceId);
    return findByKey(db, key)!;
  });
}
