import type { DB } from './db.js';
import type { ActivityStep } from './metrics.js';
import type { AgentRole, Stage } from './types.js';
import { isAiReviewMarker } from './aiReview.js';

/**
 * Cost per result (Analytics). Spend and results are shipped as two small event lists so the
 * client can apply the same workspace/range filter to both and divide: "what did the factory
 * spend on this kind of output, per output it actually produced".
 *
 * - Spend is priced `task_metric` cost bucketed by UTC day × stage × role. Stage comes from the
 *   worker session that was running (or last ran) when the report landed — the same attribution
 *   as `tokenBreakdownFor` — so review and visualization spend sit in the stage they reviewed.
 *   Unpriced reports are left out (unpriced, never $0).
 * - Results are derived from the activity log, so they work retroactively:
 *   `merged_pr`      watcher close on a merged PR (delivering → done, "PR … merged;")
 *   `approved_spec`  a description-stage approval (in_review → queued, "stage description → …")
 *   `review`         every posted ai-review/v1 verdict
 *   `send_back`      a review that requested changes (in_review → queued without a stage advance)
 *   `delivery_repair` a delivering task sent back to the queue (CI failed, PR closed, PR feedback)
 *   `reopen`         a done task reopened (done → queued)
 */
export type ResultKind = 'merged_pr' | 'approved_spec' | 'review' | 'send_back' | 'delivery_repair' | 'reopen';

export interface ResultEvent { kind: ResultKind; stage: Stage | null; workspace: string; at: string; }
export interface CostBucket { day: string; stage: Stage | null; role: AgentRole | null; workspace: string; costUsd: number; }

interface Session { stage: Stage; started_at: string; }

const STAGE_ADVANCE = /\bstage (description|plan|implementation) → /;
const MERGED = /^PR .+ merged;/;

function sessionsFor(db: DB, taskId: number): Session[] {
  return db.prepare('SELECT stage, started_at FROM agent_session WHERE task_id = ? ORDER BY started_at, id').all(taskId) as unknown as Session[];
}

/** Stage of the latest session started at or before `ts` (null before the first session). */
function stageAt(sessions: Session[], ts: string): Stage | null {
  let stage: Stage | null = null;
  for (const s of sessions) {
    if (s.started_at > ts) break;
    stage = s.stage;
  }
  return stage;
}

export function resultEventsFor(db: DB, taskId: number, workspace: string, steps: ActivityStep[]): ResultEvent[] {
  const sessions = sessionsFor(db, taskId);
  const out: ResultEvent[] = [];
  const push = (kind: ResultKind, at: string, stage: Stage | null = stageAt(sessions, at)) => out.push({ kind, stage, workspace, at });
  for (const s of steps) {
    const body = s.body ?? '';
    if (s.type === 'comment') {
      if (isAiReviewMarker(body)) push('review', s.createdAt);
      continue;
    }
    if (s.type !== 'status_change') continue;
    if (s.fromStatus === 'in_review' && s.toStatus === 'queued') {
      const advance = STAGE_ADVANCE.exec(body);
      if (!advance) push('send_back', s.createdAt);
      else if (advance[1] === 'description') push('approved_spec', s.createdAt, 'description');
    } else if (s.toStatus === 'done' && MERGED.test(body)) {
      push('merged_pr', s.createdAt, 'implementation');
    } else if (s.fromStatus === 'delivering' && s.toStatus === 'queued') {
      push('delivery_repair', s.createdAt, 'implementation');
    } else if (s.fromStatus === 'done' && s.toStatus === 'queued') {
      push('reopen', s.createdAt);
    }
  }
  return out;
}

export function costBucketsFor(db: DB, taskId: number, workspace: string): CostBucket[] {
  const metrics = db.prepare(
    `SELECT role, cost_usd, created_at FROM task_metric WHERE task_id = ? AND cost_usd IS NOT NULL ORDER BY created_at, id`,
  ).all(taskId) as Array<{ role: AgentRole | null; cost_usd: number; created_at: string }>;
  if (!metrics.length) return [];
  const sessions = sessionsFor(db, taskId);
  const out = new Map<string, CostBucket>();
  for (const m of metrics) {
    const day = m.created_at.slice(0, 10);
    const stage = stageAt(sessions, m.created_at);
    const key = JSON.stringify([day, stage, m.role]);
    const b = out.get(key) ?? { day, stage, role: m.role, workspace, costUsd: 0 };
    b.costUsd += m.cost_usd;
    out.set(key, b);
  }
  return [...out.values()];
}
