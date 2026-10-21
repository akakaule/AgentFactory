import type { DB } from '../db.js';
import type { Status, TaskMetricsView, IntakeErrorKind } from '../types.js';
import { deriveTaskMetrics } from '../metrics.js';
import { findingsAtApproval } from '../aiReview.js';
import { parseFailureComment } from '../failure.js';
import { activitySteps } from '../repo/activity.js';
import { tokenAggregateFor, stageTokensFor } from '../repo/metrics.js';
import { nowIso } from '../time.js';
import { intakeMarkerActivities } from '../repo/activity.js';
import { parseIntakeComment, parseIntakeClaimComment, intakeOverrideRevision } from '../intake.js';

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
export interface IntakeAnalytics {
  assessments: number; unavailable: number; unavailableRate: number; latencyP50: number | null; latencyP95: number | null;
  failuresByKind: Record<string, number>; coverage: { numerator: number; denominator: number };
  reassessments: number; overrides: number; authFailuresIncluded: false;
}
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; failures: FailureEvent[]; intake: IntakeAnalytics; }

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
  let assessments = 0;
  let unavailable = 0;
  let reassessments = 0;
  let overrides = 0;
  const latencies: number[] = [];
  const failuresByKind: Record<string, number> = {};
  let coverageDenominator = 0;
  let coverageNumerator = 0;

  for (const r of rows) {
    const steps = activitySteps(db, r.id);
    const intakeActivities = intakeMarkerActivities(db, r.id);
    const assessmentRows = intakeActivities.map((a) => parseIntakeComment(a.body)).filter((a): a is NonNullable<ReturnType<typeof parseIntakeComment>> => a !== null);
    assessments += assessmentRows.length;
    if (assessmentRows.length > 1) reassessments += assessmentRows.length - 1;
    for (const a of assessmentRows) {
      if (a.status === 'unavailable') unavailable += 1;
      else latencies.push(a.latencyMs);
    }
    overrides += intakeActivities.filter((a) => intakeOverrideRevision(a.body) !== null).length;
    for (const a of intakeActivities) {
      const context = parseIntakeClaimComment(a.body);
      if (context) { coverageDenominator += 1; if (context.assessmentRevision !== null && context.assessmentRevision === context.sourceRevision) coverageNumerator += 1; }
    }
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
  }
  const retryFailures = db.prepare("SELECT a.terminal_reason AS reason FROM retry_attempt a JOIN retry_budget b ON b.id = a.budget_id WHERE b.operation LIKE 'intake:assess:%' AND a.state = 'failed' AND a.terminal_reason IS NOT NULL").all() as Array<{ reason: string }>;
  const allowedKinds = new Set<IntakeErrorKind | 'abandoned'>(['timeout', 'rate_limit', 'network', 'invalid_response', 'unavailable', 'input_too_large', 'abandoned']);
  for (const row of retryFailures) if (allowedKinds.has(row.reason as IntakeErrorKind | 'abandoned')) failuresByKind[row.reason] = (failuresByKind[row.reason] ?? 0) + 1;
  const percentile = (values: number[], p: number): number | null => {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * p) - 1)]!;
  };
  return {
    tasks, stranded, failures,
    intake: {
      assessments, unavailable, unavailableRate: assessments ? unavailable / assessments : 0,
      latencyP50: percentile(latencies, 0.5), latencyP95: percentile(latencies, 0.95), failuresByKind,
      coverage: { numerator: coverageNumerator, denominator: coverageDenominator }, reassessments, overrides, authFailuresIncluded: false,
    },
  };
}
