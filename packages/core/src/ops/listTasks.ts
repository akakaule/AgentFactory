import type { DB } from '../db.js';
import type { Task, Status } from '../types.js';
import { listRows } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';

export function listTasks(db: DB, opts: { status?: Status | undefined; workspace?: string | undefined; archived?: boolean | undefined } = {}): Task[] {
  const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
  return listRows(db, { status: opts.status, workspaceId, archived: opts.archived });
}
