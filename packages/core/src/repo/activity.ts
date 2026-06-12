import type { DB } from '../db.js';
import type { Activity, ActivityType, Actor, Status } from '../types.js';
import type { ActivityStep } from '../metrics.js';

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

/**
 * Latest `ai-review:` comment body per task id (one query for the whole list). The
 * SQL pre-filters on the documented marker prefix; the JS parser is the authority on
 * the count. Returns only tasks that have such a comment — absence ⇒ no AI review.
 */
export function latestAiReviewBodies(db: DB, taskIds: number[]): Map<number, string> {
  const out = new Map<number, string>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT a.task_id AS taskId, a.body AS body FROM activity a
     JOIN (SELECT task_id, MAX(id) AS mid FROM activity
           WHERE type = 'comment' AND lower(body) LIKE 'ai-review:%'
           GROUP BY task_id) m ON a.id = m.mid
     WHERE a.task_id IN (${placeholders})`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; body: string }>;
  for (const r of rows) out.set(r.taskId, r.body);
  return out;
}
/** Full status history projection for metrics derivation (no limit, id order). */
export function activitySteps(db: DB, taskId: number): ActivityStep[] {
  const rows = db.prepare(
    'SELECT type, from_status, to_status, body, created_at FROM activity WHERE task_id = ? ORDER BY id ASC'
  ).all(taskId) as Array<{
    type: ActivityType; from_status: Status | null; to_status: Status | null; body: string; created_at: string;
  }>;
  return rows.map(r => ({ type: r.type, fromStatus: r.from_status, toStatus: r.to_status, body: r.body, createdAt: r.created_at }));
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
