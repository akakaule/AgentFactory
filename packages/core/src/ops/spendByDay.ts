import type { DB } from '../db.js';
import { ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

/** One day × workspace × model bucket of reported usage. */
export interface SpendRow {
  date: string; // UTC day, YYYY-MM-DD
  workspace: string;
  model: string | null;
  costUsd: number; // priced reports only
  tokens: number; // input + output, priced or not
  unpricedTokens: number; // tokens from reports that carried no cost — unpriced, never $0
}

export interface SpendMonth {
  month: string; // YYYY-MM (UTC)
  dataUpTo: string | null; // latest report in the selection; null when there is none
  rows: SpendRow[];
}

const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

/**
 * Reported usage for one UTC month, bucketed by day, workspace, and model. The client groups the
 * rows (by provider or by workspace), so one read serves every split. Defaults to the current month.
 */
export function spendByDay(
  db: DB,
  opts: { month?: string | undefined; workspace?: string | undefined } = {},
  now: () => string = nowIso,
): SpendMonth {
  const month = opts.month ?? now().slice(0, 7);
  if (!MONTH.test(month)) throw new ValidationError(`month must be YYYY-MM, got '${month}'`);
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-01T00:00:00.000Z`;
  const end = new Date(Date.UTC(y, m, 1)).toISOString(); // first instant of the next month
  const workspace = opts.workspace ?? null;
  const where = `tm.created_at >= ? AND tm.created_at < ? AND (? IS NULL OR w.name = ?)`;
  const from = `FROM task_metric tm JOIN task t ON t.id = tm.task_id JOIN workspace w ON w.id = t.workspace_id`;
  const params = [start, end, workspace, workspace];
  const rows = db.prepare(
    `SELECT substr(tm.created_at, 1, 10) AS date, w.name AS workspace, tm.model AS model,
            SUM(COALESCE(tm.cost_usd, 0)) AS costUsd,
            SUM(COALESCE(tm.tokens_in, 0) + COALESCE(tm.tokens_out, 0)) AS tokens,
            SUM(CASE WHEN tm.cost_usd IS NULL THEN COALESCE(tm.tokens_in, 0) + COALESCE(tm.tokens_out, 0) ELSE 0 END) AS unpricedTokens
       ${from} WHERE ${where}
      GROUP BY date, w.name, tm.model
      ORDER BY date, w.name, tm.model`
  ).all(...params) as unknown as SpendRow[];
  const latest = db.prepare(`SELECT MAX(tm.created_at) AS at ${from} WHERE ${where}`).get(...params) as { at: string | null };
  return { month, dataUpTo: latest.at, rows: rows.map((r) => ({ ...r })) };
}
