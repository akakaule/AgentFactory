import type { DB } from '../db.js';
import type { Status, TaskMetricsView } from '../types.js';
import { deriveTaskMetrics } from '../metrics.js';
import { activitySteps } from '../repo/activity.js';
import { nowIso } from '../time.js';

export interface AnalyticsTaskRow extends TaskMetricsView {
  key: string;
  workspace: string;
  status: Status;
  worker: string | null; // claimed_by of the last/current claim; null = unlabeled
}
export interface StrandedRelease { worker: string | null; workspace: string; at: string; }
export interface AnalyticsData { tasks: AnalyticsTaskRow[]; stranded: StrandedRelease[]; }

/**
 * All-time per-task metric rows + stranded-release events. The client filters
 * by workspace/range and aggregates (single-user data volumes).
 */
export function analyticsRows(db: DB, now: () => string = nowIso): AnalyticsData {
  const rows = db.prepare(
    'SELECT task.id, task.key, task.status, task.claimed_by, w.name AS workspace FROM task JOIN workspace w ON w.id = task.workspace_id ORDER BY task.id'
  ).all() as Array<{ id: number; key: string; status: Status; claimed_by: string | null; workspace: string }>;

  const ts = now();
  const tasks: AnalyticsTaskRow[] = [];
  const stranded: StrandedRelease[] = [];

  for (const r of rows) {
    const steps = activitySteps(db, r.id);
    const derived = deriveTaskMetrics(steps, ts);
    tasks.push({
      ...derived,
      key: r.key, workspace: r.workspace, status: r.status, worker: r.claimed_by,
      model: null, tokensIn: null, tokensOut: null, costUsd: null,
    });

    // a human in_progress → queued transition is a stranded-claim release,
    // attributed to the nearest preceding claim row's label (empty body → null)
    let lastClaim: string | null = null;
    for (const s of steps) {
      if (s.type !== 'status_change') continue;
      if (s.fromStatus === 'queued' && s.toStatus === 'in_progress') lastClaim = s.body || null;
      else if (s.fromStatus === 'in_progress' && s.toStatus === 'queued') {
        stranded.push({ worker: lastClaim, workspace: r.workspace, at: s.createdAt });
      }
    }
  }
  return { tasks, stranded };
}
