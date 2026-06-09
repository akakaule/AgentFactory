import type { DB } from '../db.js';
import type { Task, Status } from '../types.js';
import { listRows } from '../repo/tasks.js';

export function listTasks(db: DB, opts: { status?: Status } = {}): Task[] {
  return listRows(db, opts);
}
