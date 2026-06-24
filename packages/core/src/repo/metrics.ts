import type { DB } from '../db.js';

export interface TokenAggregate {
  model: string | null;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

const NONE: TokenAggregate = { model: null, tokensIn: null, tokensOut: null, costUsd: null };

/** SUM tokens/cost across all reports for a task; latest non-null model wins. */
export function tokenAggregateFor(db: DB, taskId: number): TokenAggregate {
  const r = db.prepare(
    'SELECT COUNT(*) n, SUM(tokens_in) ti, SUM(tokens_out) tout, SUM(cost_usd) cost FROM task_metric WHERE task_id = ?'
  ).get(taskId) as { n: number; ti: number | null; tout: number | null; cost: number | null };
  if (!r.n) return NONE;
  const m = db.prepare(
    'SELECT model FROM task_metric WHERE task_id = ? AND model IS NOT NULL ORDER BY id DESC LIMIT 1'
  ).get(taskId) as { model: string } | undefined;
  return { model: m?.model ?? null, tokensIn: r.ti, tokensOut: r.tout, costUsd: r.cost };
}

/** Per-stage token totals (tokens_in+out) for a task; the 'unknown' bucket holds reports
 *  that predate any session (legacy / never claimed through the board). */
export type StageTokens = Record<string, number>;

/**
 * Attribute each usage report to the stage that was being worked when it landed, and sum
 * tokens per stage. A report belongs to the session with the greatest `started_at` at or
 * before its `created_at` — OTel reports land mid-session, and the submit-time report lands
 * just after `submitResult` ended the session, so both map to the right stage. Reports with
 * no preceding session fall into 'unknown'. Empty map when nothing is reported.
 */
export function stageTokensFor(db: DB, taskId: number): StageTokens {
  const metrics = db.prepare(
    'SELECT COALESCE(tokens_in,0)+COALESCE(tokens_out,0) AS tok, created_at FROM task_metric WHERE task_id = ? AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)'
  ).all(taskId) as Array<{ tok: number; created_at: string }>;
  if (!metrics.length) return {};
  const sessions = db.prepare(
    'SELECT stage, started_at FROM agent_session WHERE task_id = ? ORDER BY started_at ASC'
  ).all(taskId) as Array<{ stage: string; started_at: string }>;
  const out: StageTokens = {};
  for (const m of metrics) {
    let stage = 'unknown';
    for (const s of sessions) {
      if (s.started_at <= m.created_at) stage = s.stage; // ISO timestamps sort chronologically
      else break;
    }
    out[stage] = (out[stage] ?? 0) + m.tok;
  }
  return out;
}

export interface MetricInsert {
  taskId: number; model: string | null; tokensIn: number | null; tokensOut: number | null;
  costUsd: number | null; reportedBy: string | null; createdAt: string;
}
export function insertMetric(db: DB, m: MetricInsert): void {
  db.prepare(
    'INSERT INTO task_metric(task_id, model, tokens_in, tokens_out, cost_usd, reported_by, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(m.taskId, m.model, m.tokensIn, m.tokensOut, m.costUsd, m.reportedBy, m.createdAt);
}
