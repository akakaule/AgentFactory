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

export interface MetricInsert {
  taskId: number; model: string | null; tokensIn: number | null; tokensOut: number | null;
  costUsd: number | null; reportedBy: string | null; createdAt: string;
}
export function insertMetric(db: DB, m: MetricInsert): void {
  db.prepare(
    'INSERT INTO task_metric(task_id, model, tokens_in, tokens_out, cost_usd, reported_by, created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(m.taskId, m.model, m.tokensIn, m.tokensOut, m.costUsd, m.reportedBy, m.createdAt);
}
