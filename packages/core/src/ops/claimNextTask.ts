import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity } from '../repo/activity.js';
import { oldestQueuedRow, toDetail } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { nowIso } from '../time.js';

export function claimNextTask(db: DB, workspace?: string, now: () => string = nowIso): TaskDetail | null {
  return transaction(db, () => {
    const workspaceId = workspace === undefined ? undefined : requireWorkspaceByName(db, workspace).id;
    const row = oldestQueuedRow(db, workspaceId);
    if (!row) return null;
    const ts = now();
    db.prepare("UPDATE task SET status='in_progress', updated_at=? WHERE id=? AND status='queued'").run(ts, row.id);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'agent',
      fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts,
    });
    return toDetail(db, { ...row, status: 'in_progress', updated_at: ts });
  });
}
