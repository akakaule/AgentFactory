import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity } from '../repo/activity.js';
import { oldestQueuedRow, toDetail } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { nowIso } from '../time.js';

export interface ClaimOptions {
  workspace?: string | undefined;
  claimedBy?: string | undefined;
}

export function claimNextTask(db: DB, opts: ClaimOptions = {}, now: () => string = nowIso): TaskDetail | null {
  return transaction(db, () => {
    const workspaceId = opts.workspace === undefined ? undefined : requireWorkspaceByName(db, opts.workspace).id;
    const row = oldestQueuedRow(db, workspaceId);
    if (!row) return null;
    const ts = now();
    const claimedBy = opts.claimedBy ?? null;
    db.prepare(
      "UPDATE task SET status='in_progress', claimed_by=?, claimed_at=?, updated_at=? WHERE id=? AND status='queued'"
    ).run(claimedBy, ts, ts, row.id);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'agent',
      fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts,
    });
    return toDetail(db, { ...row, status: 'in_progress', claimed_by: claimedBy, claimed_at: ts, updated_at: ts });
  });
}
