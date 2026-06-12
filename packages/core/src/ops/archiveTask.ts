import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail, setArchived } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';

// archive rides the existing 'comment' activity type — auditable without widening
// the activity-type CHECK constraint
function applyArchive(db: DB, taskId: number, archivedAt: string | null, ts: string): void {
  setArchived(db, taskId, archivedAt, ts);
  appendActivity(db, {
    taskId, type: 'comment', actor: 'human',
    body: archivedAt === null ? 'unarchived' : 'archived', createdAt: ts,
  });
}

/** Archive one done task: hidden from default listings, status and data untouched. */
export function archiveTask(db: DB, key: string, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'done')
    throw new InvalidTransitionError(`only a done task can be archived: ${key} is ${row.status}`);
  if (row.archived_at !== null)
    throw new InvalidTransitionError(`task is already archived: ${key}`);
  return transaction(db, () => {
    const ts = now();
    applyArchive(db, row.id, ts, ts);
    return toDetail(db, findRowByKey(db, key)!);
  });
}

/** Restore an archived task to the default listings (status is still 'done'). */
export function unarchiveTask(db: DB, key: string, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.archived_at === null)
    throw new InvalidTransitionError(`task is not archived: ${key}`);
  return transaction(db, () => {
    applyArchive(db, row.id, null, now());
    return toDetail(db, findRowByKey(db, key)!);
  });
}

/** Bulk-archive every active done task, optionally scoped to one workspace. */
export function archiveDoneTasks(db: DB, opts: { workspace?: string | undefined } = {}, now: () => string = nowIso): { archived: number } {
  const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
  return transaction(db, () => {
    const ts = now();
    const rows = (workspaceId === undefined
      ? db.prepare("SELECT id FROM task WHERE status = 'done' AND archived_at IS NULL").all()
      : db.prepare("SELECT id FROM task WHERE status = 'done' AND archived_at IS NULL AND workspace_id = ?").all(workspaceId)
    ) as Array<{ id: number }>;
    for (const row of rows) applyArchive(db, row.id, ts, ts);
    return { archived: rows.length };
  });
}
