import type { DB } from '../db.js';
import { STAGE_ORDER, type Stage, type TaskTokenUsage } from '../types.js';

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
  const out: StageTokens = {};
  for (const row of tokenBreakdownFor(db, taskId)) {
    const stage = row.stage ?? 'unknown';
    out[stage] = (out[stage] ?? 0) + (row.tokensIn ?? 0) + (row.tokensOut ?? 0);
  }
  return out;
}

/** Preserve every reported token once, including reports without stage/engine/model metadata.
 * Stages use session timing, not the task's current stage (which changes after approval).
 * The reporter is the only engine evidence; model names alone do not identify a CLI. */
export function tokenBreakdownFor(db: DB, taskId: number): TaskTokenUsage[] {
  const metrics = db.prepare(
    `SELECT model, reported_by, tokens_in, tokens_out, created_at FROM task_metric
     WHERE task_id = ? AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)
     ORDER BY created_at, id`,
  ).all(taskId) as Array<{ model: string | null; reported_by: string | null; tokens_in: number | null; tokens_out: number | null; created_at: string }>;
  if (!metrics.length) return [];
  const sessions = db.prepare(
    'SELECT stage, started_at FROM agent_session WHERE task_id = ? ORDER BY started_at, id',
  ).all(taskId) as Array<{ stage: Stage; started_at: string }>;
  const out = new Map<string, TaskTokenUsage>();
  let nextSession = 0;
  let stage: Stage | null = null;
  const sum = (a: number | null, b: number | null) => a === null && b === null ? null : (a ?? 0) + (b ?? 0);
  for (const m of metrics) {
    while (nextSession < sessions.length && sessions[nextSession]!.started_at <= m.created_at) {
      stage = sessions[nextSession++]!.stage;
    }
    const agent = m.reported_by === 'otel:codex' ? 'codex' : m.reported_by === 'otel:claude' ? 'claude' : null;
    const key = JSON.stringify([stage, agent, m.model]);
    const row = out.get(key) ?? { stage, agent, model: m.model, tokensIn: null, tokensOut: null };
    row.tokensIn = sum(row.tokensIn, m.tokens_in);
    row.tokensOut = sum(row.tokensOut, m.tokens_out);
    out.set(key, row);
  }
  const order = (s: Stage | null) => s === null ? STAGE_ORDER.length : STAGE_ORDER.indexOf(s);
  return [...out.values()].sort((a, b) => order(a.stage) - order(b.stage)
    || (a.agent ?? 'unknown').localeCompare(b.agent ?? 'unknown')
    || (a.model ?? 'unknown').localeCompare(b.model ?? 'unknown'));
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
