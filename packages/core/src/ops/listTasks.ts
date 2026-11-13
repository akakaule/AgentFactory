import type { DB } from '../db.js';
import type { Task, Status } from '../types.js';
import { listRows } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { POST_MERGE_CHECK_PUBLICATION_MS } from './delivery.js';
import { nowIso } from '../time.js';

/**
 * `delivery: true` narrows the listing to what the watcher can act on, in SQL — delivering tasks,
 * tasks a delivery bounced back, and merged tasks still pending or inside the post-merge check
 * window — instead of loading every task with its derived state on each poll. It is a superset of
 * the watcher's own filter (which still runs), so done tasks long past their merge drop out.
 */
/**
 * `doneSince` (the notifier's scan) drops done tasks that finished before it and have no open
 * alert: their alert state was already settled, and re-deriving every finished task's state each
 * poll grows with board history.
 */
export function listTasks(db: DB, opts: { status?: Status | undefined; workspace?: string | undefined; archived?: boolean | undefined; delivery?: boolean | undefined; doneSince?: string | undefined } = {}, now: () => string = nowIso): Task[] {
  const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
  const deliverySince = opts.delivery ? new Date(Date.parse(now()) - POST_MERGE_CHECK_PUBLICATION_MS).toISOString() : undefined;
  return listRows(db, { status: opts.status, workspaceId, archived: opts.archived, deliverySince, doneSince: opts.doneSince });
}
