import type { CurationDisposition, Status, TaskMetricsView } from '../types.js';
import type { DB } from '../db.js';
import { deriveTaskMetrics } from '../metrics.js';
import { findingsAtApproval } from '../aiReview.js';
import { parseFailureComment } from '../failure.js';
import { parseCurationComment } from '../curation.js';
import { activitySteps } from '../repo/activity.js';
import { tokenAggregateFor, stageTokensFor } from '../repo/metrics.js';
import { nowIso } from '../time.js';

export interface AnalyticsTaskRow extends TaskMetricsView {
  key: string;
  workspace: string;
  status: Status;
  worker: string | null; // claimed_by of the last/current claim; null = unlabeled
  branch: string | null; // server-named feature branch, set on first implementation claim; null before then / legacy
  stageTokens: Record<string, number>; // tokens (in+out) attributed to the stage they were reported in

  // AI-review findings standing at the final approval; null = no AI review present.
  // Drives the override-rate KPI — approving with findings > 0 is an override.
  aiReviewFindings: number | null;
}
export interface StrandedRelease { worker: string | null; workspace: string; at: string; }
/** One supervisor failure occurrence (every failure/v1 note), for the "why tasks fail" trend. */
export interface FailureEvent { reason: string; workspace: string; at: string; }
/**
 * One finding's curation disposition (every `curation/v1` ledger entry), for the reviewer-
 * precision KPI. `reopened`/`failed` snapshot the task's later fate so the client can correlate
 * forwarded findings with reopens/CI failures without a per-task join (the same task-level flag
 * repeats across that task's entries — the client dedupes by taskKey).
 */
export interface CurationEvent {
  reviewer: string | null; workspace: string; disposition: CurationDisposition;
  taskKey: string; at: string; reopened: boolean; failed: boolean;
}
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; failures: FailureEvent[]; curations: CurationEvent[]; }

/**
 * All-time per-task metric rows + stranded-release events. The client filters
 * by workspace/range and aggregates (single-user data volumes).
 */
export function analyticsRows(db: DB, now: () => string = nowIso): AnalyticsData {
  const rows = db.prepare(
    'SELECT task.id, task.key, task.status, task.claimed_by, task.branch, w.name AS workspace FROM task JOIN workspace w ON w.id = task.workspace_id ORDER BY task.id'
  ).all() as Array<{ id: number; key: string; status: Status; claimed_by: string | null; branch: string | null; workspace: string }>;

  const ts = now();
  const tasks: AnalyticsTaskRow[] = [];
  const stranded: StrandedRelease[] = [];
  const failures: FailureEvent[] = [];
  const curations: CurationEvent[] = [];

  for (const r of rows) {
    const steps = activitySteps(db, r.id);
    const derived = deriveTaskMetrics(steps, ts);
    tasks.push({
      ...derived,
      ...tokenAggregateFor(db, r.id),
      key: r.key, workspace: r.workspace, status: r.status, worker: r.claimed_by, branch: r.branch,
      stageTokens: stageTokensFor(db, r.id),
      aiReviewFindings: findingsAtApproval(steps),
    });

    // a human in_progress → queued transition is a stranded-claim release,
    // attributed to the nearest preceding claim row's label (empty body → null)
    let lastClaim: string | null = null;
    for (const s of steps) {
      // every failure/v1 note is one failure occurrence (a task can fail more than once)
      if (s.type === 'comment' && s.body) {
        const f = parseFailureComment(s.body);
        if (f) failures.push({ reason: f.reason, workspace: r.workspace, at: s.createdAt });
        continue;
      }
      if (s.type !== 'status_change') continue;
      if (s.fromStatus === 'queued' && s.toStatus === 'in_progress') lastClaim = s.body || null;
      else if (s.fromStatus === 'in_progress' && s.toStatus === 'queued') {
        stranded.push({ worker: lastClaim, workspace: r.workspace, at: s.createdAt });
      }
    }

    // Curation ledger → reviewer-precision KPI. Each `curation/v1` entry becomes one event,
    // tagged with the task's later fate (reopened / any failure/v1) so the client can correlate
    // forwarded findings with reopens/CI failures.
    const taskFailed = steps.some((s) => s.type === 'comment' && !!s.body && parseFailureComment(s.body) !== null);
    for (const s of steps) {
      if (s.type !== 'comment' || !s.body) continue;
      const parsed = parseCurationComment(s.body);
      if (!parsed) continue;
      for (const d of parsed.dispositions) {
        curations.push({
          reviewer: parsed.reviewer, workspace: r.workspace, disposition: d.disposition,
          taskKey: r.key, at: s.createdAt, reopened: derived.reopened, failed: taskFailed,
        });
      }
    }
  }
  return { tasks, stranded, failures, curations };
}
