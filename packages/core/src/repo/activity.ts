import type { DB } from '../db.js';
import type { Activity, ActivityFeedRow, ActivityType, Actor, Status } from '../types.js';
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
           WHERE type = 'comment' AND (lower(ltrim(body)) LIKE 'ai-review/v1%' OR lower(ltrim(body)) LIKE 'ai-review/v2%')
           GROUP BY task_id) m ON a.id = m.mid
     WHERE a.task_id IN (${placeholders})`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; id: number; body: string }>;
  for (const r of rows) out.set(r.taskId, { id: r.id, body: r.body });
  return out;
}

/**
 * Latest `failure/v1` comment (id + body + created_at) per task id (one query for the whole
 * list). Mirrors latestAiReviewComments: the SQL pre-filters on the marker prefix, the JS
 * parser is the authority on well-formedness. The id rides along so callers can compare it to
 * the latest result (a newer result supersedes the failure ⇒ no longer current).
 */
export function latestFailureComments(db: DB, taskIds: number[]): Map<number, { id: number; body: string; createdAt: string }> {
  const out = new Map<number, { id: number; body: string; createdAt: string }>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT a.task_id AS taskId, a.id AS id, a.body AS body, a.created_at AS createdAt FROM activity a
     JOIN (SELECT task_id, MAX(id) AS mid FROM activity
           WHERE type = 'comment' AND lower(body) LIKE 'failure/v1%'
           GROUP BY task_id) m ON a.id = m.mid
     WHERE a.task_id IN (${placeholders})`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; id: number; body: string; createdAt: string }>;
  for (const r of rows) out.set(r.taskId, { id: r.id, body: r.body, createdAt: r.createdAt });
  return out;
}

export interface FailureNoteRow { id: number; body: string; createdAt: string; }

/**
 * The latest `failure/v1` comment per task plus the one before it (one windowed query for the whole
 * list). `latest` is exactly latestFailureComments' selection; `previous` feeds the failure-triage
 * evidence rule (a log-less `max_attempts` note reads the final attempt's note just before it).
 */
export function latestFailureNotePairs(db: DB, taskIds: number[]): Map<number, { latest: FailureNoteRow; previous: FailureNoteRow | null }> {
  const out = new Map<number, { latest: FailureNoteRow; previous: FailureNoteRow | null }>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT taskId, id, body, createdAt, rn FROM (
       SELECT task_id AS taskId, id, body, created_at AS createdAt,
              ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY id DESC) AS rn
         FROM activity
        WHERE type = 'comment' AND lower(body) LIKE 'failure/v1%' AND task_id IN (${placeholders})
     ) WHERE rn <= 2 ORDER BY taskId, rn`,
  ).all(...taskIds) as Array<{ taskId: number; id: number; body: string; createdAt: string; rn: number }>;
  for (const r of rows) {
    const note = { id: r.id, body: r.body, createdAt: r.createdAt };
    if (r.rn === 1) out.set(r.taskId, { latest: note, previous: null });
    else { const pair = out.get(r.taskId); if (pair) pair.previous = note; }
  }
  return out;
}

/** One task's `failure/v1` comments newest first, strictly older than `beforeId` when given. */
export function failureNotesDesc(db: DB, taskId: number, beforeId: number | null, limit: number): FailureNoteRow[] {
  return db.prepare(
    `SELECT id, body, created_at AS createdAt FROM activity
      WHERE task_id = ? AND type = 'comment' AND lower(body) LIKE 'failure/v1%' AND id < ?
      ORDER BY id DESC LIMIT ?`,
  ).all(taskId, beforeId ?? Number.MAX_SAFE_INTEGER, limit) as unknown as FailureNoteRow[];
}

/**
 * True iff progress that clears a failure (a result, an ai-review marker, or a restart marker —
 * the failureByTaskIds supersede set) landed strictly between two activity ids of one task.
 */
export function failureClearedBetween(db: DB, taskId: number, afterId: number, beforeId: number): boolean {
  const row = db.prepare(
    `SELECT 1 AS hit FROM activity
      WHERE task_id = ? AND id > ? AND id < ?
        AND (type = 'result'
             OR (type = 'comment' AND (lower(ltrim(body)) LIKE 'ai-review/v1%' OR lower(ltrim(body)) LIKE 'ai-review/v2%'
                                      OR lower(body) LIKE 'restart/v1%')))
      LIMIT 1`,
  ).get(taskId, afterId, beforeId) as { hit: number } | undefined;
  return row !== undefined;
}

/** `failure-triage-feedback/v1` comments per task, newest first, with the human's display name. */
export function failureTriageFeedbackActivities(db: DB, taskIds: number[]): Map<number, Activity[]> {
  const out = new Map<number, Activity[]>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT a.id, a.task_id, a.type, a.actor, a.from_status, a.to_status, a.body, a.created_at,
            a.actor_user_id, u.display_name AS actor_name
       FROM activity a LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.task_id IN (${placeholders}) AND a.type = 'comment' AND lower(ltrim(a.body)) LIKE 'failure-triage-feedback/v1%'
      ORDER BY a.id DESC`,
  ).all(...taskIds) as Array<{
    id: number; task_id: number; type: ActivityType; actor: Actor;
    from_status: Status | null; to_status: Status | null; body: string; created_at: string;
    actor_user_id: number | null; actor_name: string | null;
  }>;
  for (const r of rows) {
    const activity: Activity = {
      id: r.id, taskId: r.task_id, type: r.type, actor: r.actor, fromStatus: r.from_status, toStatus: r.to_status,
      body: r.body, createdAt: r.created_at, actorUserId: r.actor_user_id, actorName: r.actor_name,
    };
    out.set(r.task_id, [...(out.get(r.task_id) ?? []), activity]);
  }
  return out;
}

/** One activity row of a task (null when absent or owned by another task). */
export function activityOfTask(db: DB, taskId: number, activityId: number): Activity | null {
  const r = db.prepare(
    `SELECT a.id, a.task_id, a.type, a.actor, a.from_status, a.to_status, a.body, a.created_at,
            a.actor_user_id, u.display_name AS actor_name
       FROM activity a LEFT JOIN app_user u ON u.id = a.actor_user_id
      WHERE a.task_id = ? AND a.id = ?`,
  ).get(taskId, activityId) as {
    id: number; task_id: number; type: ActivityType; actor: Actor;
    from_status: Status | null; to_status: Status | null; body: string; created_at: string;
    actor_user_id: number | null; actor_name: string | null;
  } | undefined;
  if (!r) return null;
  return {
    id: r.id, taskId: r.task_id, type: r.type, actor: r.actor, fromStatus: r.from_status, toStatus: r.to_status,
    body: r.body, createdAt: r.created_at, actorUserId: r.actor_user_id, actorName: r.actor_name,
  };
}

/**
 * All comment bodies starting with `prefix` for one task, newest first — the FULL history,
 * not the recentActivity window (a chatty delivering task scrolls markers past that cap).
 * The SQL pre-filters on the marker prefix; the caller's parser stays the authority on
 * well-formedness (callers take the first parseable body).
 */
export function markerCommentsDesc(db: DB, taskId: number, prefix: string): string[] {
  const rows = db.prepare(
    `SELECT body FROM activity WHERE task_id = ? AND type = 'comment' AND lower(body) LIKE ? ORDER BY id DESC`
  ).all(taskId, `${prefix.toLowerCase()}%`) as Array<{ body: string }>;
  return rows.map((r) => r.body);
}

export interface MarkerActivity { id: number; taskId: number; actor: Actor; body: string; createdAt: string; }
export function intakeMarkerActivities(db: DB, taskId: number): MarkerActivity[] {
  const rows = db.prepare(
    `SELECT id, task_id AS taskId, actor, body, created_at AS createdAt FROM activity
     WHERE task_id = ? AND type = 'comment'
       AND (lower(ltrim(body)) LIKE 'intake/v1%' OR lower(ltrim(body)) LIKE 'intake-override/v1%' OR lower(ltrim(body)) LIKE 'intake-claim/v1%')
     ORDER BY id DESC`,
  ).all(taskId) as unknown as MarkerActivity[];
  return rows;
}
export function intakeMarkerActivitiesByTaskIds(db: DB, taskIds: number[]): Map<number, MarkerActivity[]> {
  const out = new Map<number, MarkerActivity[]>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT id, task_id AS taskId, actor, body, created_at AS createdAt FROM activity
     WHERE task_id IN (${placeholders}) AND type = 'comment'
       AND (lower(ltrim(body)) LIKE 'intake/v1%' OR lower(ltrim(body)) LIKE 'intake-override/v1%' OR lower(ltrim(body)) LIKE 'intake-claim/v1%')
     ORDER BY id DESC`,
  ).all(...taskIds) as unknown as MarkerActivity[];
  for (const row of rows) out.set(row.taskId, [...(out.get(row.taskId) ?? []), row]);
  return out;
}

/**
 * Latest `restart/v1` marker id per task id (one query for the whole list). An operator restart
 * newer than the latest failure note supersedes it (like a fresh result) ⇒ the failure clears.
 * Mirrors latestResultIds — the SQL pre-filters on the marker prefix; only the id is needed.
 */
export function latestRestartMarkerIds(db: DB, taskIds: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (taskIds.length === 0) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT task_id AS taskId, MAX(id) AS mid FROM activity
     WHERE type = 'comment' AND lower(body) LIKE 'restart/v1%' AND task_id IN (${placeholders}) GROUP BY task_id`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...taskIds) as Array<{ taskId: number; mid: number }>;
  for (const r of rows) out.set(r.taskId, r.mid);
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

/** The latest activity id (the high-water mark a feed consumer initializes its cursor to). 0 = empty. */
export function latestActivityId(db: DB): number {
  const r = db.prepare('SELECT MAX(id) AS m FROM activity').get() as { m: number | null };
  return r.m ?? 0;
}

/**
 * The global activity feed since `sinceId` (exclusive), oldest first, joined to each row's task +
 * workspace. The notifier polls this to derive cross-task events (a task entered review, a failure
 * note was posted) without per-task queries; the id is the durable cursor.
 */
export function activitySince(db: DB, sinceId: number, limit = 200): ActivityFeedRow[] {
  return db.prepare(
    `SELECT a.id AS id, t.key AS taskKey, t.title AS taskTitle, w.name AS workspace,
            a.type AS type, a.actor AS actor, a.to_status AS toStatus, a.body AS body, a.created_at AS createdAt
       FROM activity a JOIN task t ON t.id = a.task_id JOIN workspace w ON w.id = t.workspace_id
      WHERE a.id > ? ORDER BY a.id ASC LIMIT ?`,
  ).all(sinceId, limit) as unknown as ActivityFeedRow[];
}

export function recentActivity(db: DB, taskId: number, limit: number): Activity[] {
  const rows = db.prepare(
    `SELECT a.id, a.task_id, a.type, a.actor, a.from_status, a.to_status, a.body, a.created_at,
            a.actor_user_id, u.display_name AS actor_name
     FROM activity a LEFT JOIN app_user u ON u.id = a.actor_user_id
     WHERE a.task_id = ?
       AND NOT (lower(ltrim(a.body)) LIKE 'intake/v1%' OR lower(ltrim(a.body)) LIKE 'intake-override/v1%' OR lower(ltrim(a.body)) LIKE 'intake-claim/v1%')
       AND NOT (lower(ltrim(a.body)) LIKE 'failure-triage/v1%' OR lower(ltrim(a.body)) LIKE 'failure-triage-feedback/v1%')
     ORDER BY a.id DESC LIMIT ?`
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
