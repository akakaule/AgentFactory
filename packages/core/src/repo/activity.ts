import type { DB } from '../db.js';
import type { Activity, ActivityType, Actor, Status } from '../types.js';
import type { ActivityStep } from '../metrics.js';

export interface AppendActivity {
  taskId: number; type: ActivityType; actor: Actor;
  fromStatus?: Status | null; toStatus?: Status | null; body?: string; createdAt: string;
  actorUserId?: number | null; // the human behind a 'human' action; omitted/null for agent/system
}
export function appendActivity(db: DB, a: AppendActivity): void {
  db.prepare(
    `INSERT INTO activity(task_id,type,actor,from_status,to_status,body,created_at,actor_user_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(a.taskId, a.type, a.actor, a.fromStatus ?? null, a.toStatus ?? null, a.body ?? '', a.createdAt, a.actorUserId ?? null);
}

/**
 * Latest `ai-review/v1` comment (id + body) per task id (one query for the whole list).
 * The SQL pre-filters on the documented marker prefix; the JS parser is the authority on
 * whether it is well-formed. Returns only tasks that have such a comment — absence ⇒ no
 * AI review. The id rides along so callers can compare it to the latest result (pending).
 */
export function latestAiReviewComments(db: DB, taskIds: number[]): Map<number, { id: number; body: string }> {
  const out = new Map<number, { id: number; body: string }>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT a.task_id AS taskId, a.id AS id, a.body AS body FROM activity a
     JOIN (SELECT task_id, MAX(id) AS mid FROM activity
           WHERE type = 'comment' AND lower(body) LIKE 'ai-review/v1%'
           GROUP BY task_id) m ON a.id = m.mid
     WHERE a.task_id IN (${placeholders})`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; id: number; body: string }>;
  for (const r of rows) out.set(r.taskId, { id: r.id, body: r.body });
  return out;
}

/**
 * Latest `result` activity id per task id (one query for the whole list). A result newer
 * than the latest ai-review comment means a resubmission is awaiting re-review ⇒ pending.
 */
export function latestResultIds(db: DB, taskIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT task_id AS taskId, MAX(id) AS mid FROM activity
     WHERE type = 'result' AND task_id IN (${placeholders}) GROUP BY task_id`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; mid: number }>;
  for (const r of rows) out.set(r.taskId, r.mid);
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
    `SELECT a.id, a.task_id, a.type, a.actor, a.from_status, a.to_status, a.body, a.created_at,
            a.actor_user_id, u.display_name AS actor_name
     FROM activity a LEFT JOIN app_user u ON u.id = a.actor_user_id
     WHERE a.task_id = ? ORDER BY a.id DESC LIMIT ?`
  ).all(taskId, limit) as Array<{
    id: number; task_id: number; type: ActivityType; actor: Actor;
    from_status: Status | null; to_status: Status | null; body: string; created_at: string;
    actor_user_id: number | null; actor_name: string | null;
  }>;
  return rows.reverse().map(r => ({
    id: r.id, taskId: r.task_id, type: r.type, actor: r.actor,
    fromStatus: r.from_status, toStatus: r.to_status, body: r.body, createdAt: r.created_at,
    actorUserId: r.actor_user_id, actorName: r.actor_name,
  }));
}
