import type { DB } from '../db.js';
import type { Task, TaskDetail, Status, Stage, TaskKind, UpdateTaskInput, AiReviewSummary, FailureSummary, ReviewGateSummary } from '../types.js';
import { RECENT_ACTIVITY_LIMIT, AUTO_REVIEW_LIMIT } from '../types.js';
import { recentActivity, activitySteps, latestAiReviewComments, latestFailureComments, latestResultIds, latestRestartMarkerIds } from './activity.js';
import { linksFor } from './links.js';
import { attachmentsMeta } from './attachments.js';
import { visualizationMetaFor } from './visualizations.js';
import { deriveTaskMetrics } from '../metrics.js';
import { parseAiReviewComment, summarizeAiReview } from '../aiReview.js';
import { parseFailureComment, summarizeFailure } from '../failure.js';
import { deliveryByTaskIds } from './delivery.js';
import { tokenAggregateFor } from './metrics.js';
import { nowIso } from '../time.js';

export interface TaskRow {
  id: number; key: string; title: string; spec: string; acceptance_criteria: string;
  status: Status; stage: Stage; kind: TaskKind; result_summary: string | null; seq: number; created_at: string; updated_at: string;
  workspace_id: number; workspace_name: string; workspace_repo_path: string;
  workspace_policy: string | null; workspace_verify_command: string | null;
  claimed_by: string | null; claimed_at: string | null; branch: string | null; plan: string | null;
  archived_at: string | null;
  auto_review_enabled: number; auto_review_rounds: number;
  original_spec: string | null; original_acceptance_criteria: string | null;
}

// every Task/TaskDetail payload carries the workspace slug (and repoPath + discipline on detail),
// so all task SELECTs go through this JOIN
const SELECT_TASK =
  'SELECT task.*, w.name AS workspace_name, w.repo_path AS workspace_repo_path, w.policy AS workspace_policy, w.verify_command AS workspace_verify_command FROM task JOIN workspace w ON w.id = task.workspace_id';

// aiReview + failure are derived (latest ai-review / failure comment) and layered on by the
// DB-aware paths below; toTask itself is pure and defaults both to null.
export function toTask(r: TaskRow): Task {
  return {
    id: r.id, key: r.key, title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, stage: r.stage, kind: r.kind, resultSummary: r.result_summary, seq: r.seq, workspace: r.workspace_name,
    claimedBy: r.claimed_by, claimedAt: r.claimed_at, archivedAt: r.archived_at, aiReview: null,
    reviewGate: {
      autoIterate: r.auto_review_enabled === 1,
      autoRounds: r.auto_review_rounds,
      autoLimit: AUTO_REVIEW_LIMIT,
      humanReviewed: false,
      aiOnly: false,
    },
    failure: null, delivery: null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function latestHumanReviewActionIds(db: DB, ids: number[]): Map<number, number> {
  const out = new Map<number, number>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT task_id AS taskId, MAX(id) AS mid FROM activity
     WHERE actor = 'human'
       AND task_id IN (${placeholders})
       AND (
         type = 'feedback'
         OR (type = 'status_change' AND from_status = 'in_review' AND to_status IN ('queued','delivering','done'))
       )
     GROUP BY task_id`
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ).all(...ids) as Array<{ taskId: number; mid: number }>;
  for (const r of rows) out.set(r.taskId, r.mid);
  return out;
}

/**
 * Latest current failure per task id, derived from the latest `failure/v1` comment and whether
 * a result supersedes it (a successful submission clears the failure). Malformed marker
 * comments are skipped. Mirrors aiReviewByTaskIds.
 */
function failureByTaskIds(db: DB, ids: number[]): Map<number, FailureSummary> {
  const out = new Map<number, FailureSummary>();
  if (ids.length === 0) return out;
  const comments = latestFailureComments(db, ids);
  if (comments.size === 0) return out;
  const keys = [...comments.keys()];
  // A failure is cleared by later *progress*: a new result (a worker crash superseded by a
  // successful submission), a new ai-review comment (a reviewer crash superseded by a
  // successful re-review), OR an operator restart/v1 marker (a skip-listed task restarted from
  // the board). Take the max id of any as the supersede marker.
  const results = latestResultIds(db, keys);
  const reviews = latestAiReviewComments(db, keys);
  const restarts = latestRestartMarkerIds(db, keys);
  for (const [taskId, { id: failureId, body, createdAt }] of comments) {
    const parsed = parseFailureComment(body);
    if (!parsed) continue;
    const progressId = Math.max(results.get(taskId) ?? 0, reviews.get(taskId)?.id ?? 0, restarts.get(taskId) ?? 0);
    const summary = summarizeFailure(parsed, createdAt, progressId > failureId);
    if (summary) out.set(taskId, summary);
  }
  return out;
}

/**
 * Latest ai-review verdict per task id, derived from the latest `ai-review/v1` comment
 * and whether a result supersedes it (pending). Malformed marker comments are skipped —
 * they degrade to plain comments and carry no chip.
 */
function aiReviewByTaskIds(db: DB, ids: number[]): Map<number, AiReviewSummary> {
  const out = new Map<number, AiReviewSummary>();
  if (ids.length === 0) return out;
  const comments = latestAiReviewComments(db, ids);
  if (comments.size === 0) return out;
  const results = latestResultIds(db, [...comments.keys()]);
  for (const [taskId, { id: reviewId, body }] of comments) {
    const parsed = parseAiReviewComment(body);
    if (!parsed) continue;
    const resultId = results.get(taskId);
    const superseded = resultId !== undefined && resultId > reviewId;
    const summary = summarizeAiReview(parsed, superseded);
    if (summary) out.set(taskId, summary);
  }
  return out;
}

function reviewGateByTaskIds(db: DB, rows: TaskRow[]): Map<number, ReviewGateSummary> {
  const out = new Map<number, ReviewGateSummary>();
  if (rows.length === 0) return out;
  const ids = rows.map((r) => r.id);
  const reviews = latestAiReviewComments(db, ids);
  const results = latestResultIds(db, ids);
  const humanActions = latestHumanReviewActionIds(db, ids);
  for (const r of rows) {
    const latestResultId = results.get(r.id) ?? 0;
    const humanReviewed = (humanActions.get(r.id) ?? 0) > latestResultId;
    const review = reviews.get(r.id);
    const parsed = review ? parseAiReviewComment(review.body) : null;
    const superseded = review !== undefined && latestResultId > review.id;
    const aiOnly = parsed !== null && !superseded && !humanReviewed;
    out.set(r.id, {
      autoIterate: r.auto_review_enabled === 1,
      autoRounds: r.auto_review_rounds,
      autoLimit: AUTO_REVIEW_LIMIT,
      humanReviewed,
      aiOnly,
    });
  }
  return out;
}

/** Latest ai-review verdict for one task (or null). Used by the approve path. */
export function aiReviewFor(db: DB, taskId: number): AiReviewSummary | null {
  return aiReviewByTaskIds(db, [taskId]).get(taskId) ?? null;
}

export function toDetail(db: DB, r: TaskRow): TaskDetail {
  const viz = visualizationMetaFor(db, r.id);
  const reviewGate = reviewGateByTaskIds(db, [r]).get(r.id)!;
  return {
    ...toTask(r),
    aiReview: aiReviewByTaskIds(db, [r.id]).get(r.id) ?? null,
    reviewGate,
    failure: failureByTaskIds(db, [r.id]).get(r.id) ?? null,
    delivery: deliveryByTaskIds(db, [r.id]).get(r.id) ?? null,
    hasVisualization: viz !== null,
    visualizationGeneratedAt: viz?.generatedAt ?? null,
    repoPath: r.workspace_repo_path,
    branch: r.branch,
    plan: r.plan,
    originalSpec: r.original_spec,
    originalAcceptanceCriteria: r.original_acceptance_criteria,
    policy: r.workspace_policy,
    verifyCommand: r.workspace_verify_command,
    activity: recentActivity(db, r.id, RECENT_ACTIVITY_LIMIT),
    links: linksFor(db, r.id),
    attachments: attachmentsMeta(db, r.id),
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
export function setStage(db: DB, id: number, stage: Stage, ts: string): void {
  db.prepare('UPDATE task SET stage = ?, updated_at = ? WHERE id = ?').run(stage, ts, id);
}
export function setPlan(db: DB, id: number, plan: string, ts: string): void {
  db.prepare('UPDATE task SET plan = ?, updated_at = ? WHERE id = ?').run(plan, ts, id);
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
export function setAutoReview(db: DB, id: number, enabled: boolean, ts: string): void {
  db.prepare(
    enabled
      ? 'UPDATE task SET auto_review_enabled = 1, auto_review_rounds = 0, updated_at = ? WHERE id = ?'
      : 'UPDATE task SET auto_review_enabled = 0, updated_at = ? WHERE id = ?'
  ).run(ts, id);
}
export function incrementAutoReviewRounds(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE task SET auto_review_rounds = auto_review_rounds + 1, updated_at = ? WHERE id = ?').run(ts, id);
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
/**
 * One-time snapshot of the human-written spec/acceptance criteria, taken just before the
 * description stage rewrites them. The `original_spec IS NULL` guard makes it idempotent:
 * the first description-stage submit captures the original; later re-submits never clobber it.
 */
export function snapshotOriginal(db: DB, id: number, spec: string, acceptanceCriteria: string, ts: string): void {
  db.prepare(
    `UPDATE task SET original_spec = ?, original_acceptance_criteria = ?, updated_at = ?
     WHERE id = ? AND original_spec IS NULL`,
  ).run(spec, acceptanceCriteria, ts, id);
}
export function setArchived(db: DB, id: number, archivedAt: string | null, ts: string): void {
  // bumping updated_at moves getVersion(), so SSE-driven clients refetch on (un)archive
  db.prepare('UPDATE task SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, ts, id);
}
export function listRows(db: DB, opts: { status?: Status | undefined; workspaceId?: number | undefined; archived?: boolean | undefined } = {}): Task[] {
  // archived rows are opt-in: every default listing (board, queue, MCP list_tasks) hides them
  const where: string[] = [opts.archived ? 'task.archived_at IS NOT NULL' : 'task.archived_at IS NULL'];
  const vals: (string | number)[] = [];
  if (opts.status) { where.push('task.status = ?'); vals.push(opts.status); }
  if (opts.workspaceId !== undefined) { where.push('task.workspace_id = ?'); vals.push(opts.workspaceId); }
  const sql = `${SELECT_TASK}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY task.seq ASC`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.prepare(sql).all as (...a: any[]) => unknown)(...vals) as TaskRow[];
  const ids = rows.map((r) => r.id);
  const reviews = aiReviewByTaskIds(db, ids);
  const gates = reviewGateByTaskIds(db, rows);
  const failures = failureByTaskIds(db, ids);
  const deliveries = deliveryByTaskIds(db, ids);
  return rows.map((r) => ({ ...toTask(r), aiReview: reviews.get(r.id) ?? null, reviewGate: gates.get(r.id)!, failure: failures.get(r.id) ?? null, delivery: deliveries.get(r.id) ?? null }));
}
export function oldestQueuedRow(db: DB, workspaceId?: number): TaskRow | undefined {
  // archived rows are always done, but the guard makes "never claim an archived task"
  // hold unconditionally rather than by inference. The kind guard is defense in depth:
  // a pr-review task is reviewed, never implemented (updateStatus blocks it from ever
  // reaching 'queued'), so a worker must never claim one even if one is stranded there.
  return (workspaceId === undefined
    ? db.prepare(`${SELECT_TASK} WHERE task.status='queued' AND task.kind != 'pr-review' AND task.archived_at IS NULL ORDER BY task.seq ASC LIMIT 1`).get()
    : db.prepare(`${SELECT_TASK} WHERE task.status='queued' AND task.kind != 'pr-review' AND task.archived_at IS NULL AND task.workspace_id = ? ORDER BY task.seq ASC LIMIT 1`).get(workspaceId)
  ) as TaskRow | undefined;
}
