import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { linksFor } from '../repo/links.js';
import { toTask, type TaskRow } from '../repo/tasks.js';
import { nowIso } from '../time.js';

export function claimNextTask(db: DB, now: () => string = nowIso): TaskDetail | null {
  return transaction(db, () => {
    const row = db.prepare(
      "SELECT * FROM task WHERE status='queued' ORDER BY seq ASC LIMIT 1"
    ).get() as TaskRow | undefined;
    if (!row) return null;
    const ts = now();
    db.prepare("UPDATE task SET status='in_progress', updated_at=? WHERE id=? AND status='queued'").run(ts, row.id);
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor: 'agent',
      fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts,
    });
    const task = toTask({ ...row, status: 'in_progress', updated_at: ts });
    return { ...task, activity: recentActivity(db, row.id, RECENT_ACTIVITY_LIMIT), links: linksFor(db, row.id) };
  });
}
