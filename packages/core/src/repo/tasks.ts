import type { DB } from '../db.js';
import type { Task, TaskDetail, Status, UpdateTaskInput } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { recentActivity, activitySteps } from './activity.js';
import { linksFor } from './links.js';
import { deriveTaskMetrics } from '../metrics.js';
import { tokenAggregateFor } from './metrics.js';
import { nowIso } from '../time.js';

export interface TaskRow {
  id: number; key: string; title: string; spec: string; acceptance_criteria: string;
  status: Status; result_summary: string | null; seq: number; created_at: string; updated_at: string;
  workspace_id: number; workspace_name: string; workspace_repo_path: string;
  claimed_by: string | null; claimed_at: string | null;
}

// every Task/TaskDetail payload carries the workspace slug (and repoPath on detail),
// so all task SELECTs go through this JOIN
const SELECT_TASK =
  'SELECT task.*, w.name AS workspace_name, w.repo_path AS workspace_repo_path FROM task JOIN workspace w ON w.id = task.workspace_id';

export function toTask(r: TaskRow): Task {
  return {
    id: r.id, key: r.key, title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, resultSummary: r.result_summary, seq: r.seq, workspace: r.workspace_name,
    claimedBy: r.claimed_by, claimedAt: r.claimed_at,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function toDetail(db: DB, r: TaskRow): TaskDetail {
  return {
    ...toTask(r),
    repoPath: r.workspace_repo_path,
    activity: recentActivity(db, r.id, RECENT_ACTIVITY_LIMIT),
    links: linksFor(db, r.id),
    metrics: {
      ...deriveTaskMetrics(activitySteps(db, r.id), nowIso()),
      ...tokenAggregateFor(db, r.id),
    },
  };
}

export function findRowByKey(db: DB, key: string): TaskRow | undefined {
  return db.prepare(`${SELECT_TASK} WHERE task.key = ?`).get(key) as TaskRow | undefined;
}
export function findByKey(db: DB, key: string): Task | null {
  const r = findRowByKey(db, key);
  return r ? toTask(r) : null;
}
export function setStatus(db: DB, id: number, status: Status, ts: string): void {
  // a re-queued task must not advertise a stale claimant — every path into 'queued'
  // (release, request-changes, blocked → queued) flows through here
  if (status === 'queued') {
    db.prepare('UPDATE task SET status = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?').run(status, ts, id);
  } else {
    db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
  }
}
export function setResultSummary(db: DB, id: number, summary: string, ts: string): void {
  db.prepare('UPDATE task SET result_summary = ?, updated_at = ? WHERE id = ?').run(summary, ts, id);
}
export function deleteRowById(db: DB, id: number): void {
  // activity and link rows go with it (ON DELETE CASCADE; foreign_keys=ON per connection)
  db.prepare('DELETE FROM task WHERE id = ?').run(id);
}
export function touch(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, id);
}
export function applyEdit(db: DB, id: number, fields: UpdateTaskInput, ts: string): void {
  const sets: string[] = [];
  // Cast to (string | number)[] — SQLInputValue includes both; spread is valid at runtime.
  const vals: (string | number)[] = [];
  if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title); }
  if (fields.spec !== undefined) { sets.push('spec = ?'); vals.push(fields.spec); }
  if (fields.acceptanceCriteria !== undefined) { sets.push('acceptance_criteria = ?'); vals.push(fields.acceptanceCriteria); }
  sets.push('updated_at = ?'); vals.push(ts);
  vals.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
export function listRows(db: DB, opts: { status?: Status | undefined; workspaceId?: number | undefined } = {}): Task[] {
  const where: string[] = [];
  const vals: (string | number)[] = [];
  if (opts.status) { where.push('task.status = ?'); vals.push(opts.status); }
  if (opts.workspaceId !== undefined) { where.push('task.workspace_id = ?'); vals.push(opts.workspaceId); }
  const sql = `${SELECT_TASK}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY task.seq ASC`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.prepare(sql).all as (...a: any[]) => unknown)(...vals) as TaskRow[];
  return rows.map(toTask);
}
export function oldestQueuedRow(db: DB, workspaceId?: number): TaskRow | undefined {
  return (workspaceId === undefined
    ? db.prepare(`${SELECT_TASK} WHERE task.status='queued' ORDER BY task.seq ASC LIMIT 1`).get()
    : db.prepare(`${SELECT_TASK} WHERE task.status='queued' AND task.workspace_id = ? ORDER BY task.seq ASC LIMIT 1`).get(workspaceId)
  ) as TaskRow | undefined;
}
