import type { DB } from '../db.js';
import type { Activity, ActivityType, Actor, Status } from '../types.js';

export interface AppendActivity {
  taskId: number; type: ActivityType; actor: Actor;
  fromStatus?: Status | null; toStatus?: Status | null; body?: string; createdAt: string;
}
export function appendActivity(db: DB, a: AppendActivity): void {
  db.prepare(
    `INSERT INTO activity(task_id,type,actor,from_status,to_status,body,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(a.taskId, a.type, a.actor, a.fromStatus ?? null, a.toStatus ?? null, a.body ?? '', a.createdAt);
}
export function recentActivity(db: DB, taskId: number, limit: number): Activity[] {
  const rows = db.prepare(
    'SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT ?'
  ).all(taskId, limit) as Array<{
    id: number; task_id: number; type: ActivityType; actor: Actor;
    from_status: Status | null; to_status: Status | null; body: string; created_at: string;
  }>;
  return rows.reverse().map(r => ({
    id: r.id, taskId: r.task_id, type: r.type, actor: r.actor,
    fromStatus: r.from_status, toStatus: r.to_status, body: r.body, createdAt: r.created_at,
  }));
}
