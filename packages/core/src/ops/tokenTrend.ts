import type { DB } from '../db.js';
import { nowIso } from '../time.js';

export interface TokenTrendPoint {
  date: string;
  tokensIn: number;
  tokensOut: number;
}

/** Daily token usage for the current UTC day and the preceding 29 UTC days. */
export function tokenTrend(
  db: DB,
  opts: { workspace?: string | undefined } = {},
  now: () => string = nowIso,
): TokenTrendPoint[] {
  const today = now().slice(0, 10);
  const todayMs = Date.parse(`${today}T00:00:00.000Z`);
  const dates = Array.from({ length: 30 }, (_, index) =>
    new Date(todayMs - (29 - index) * 86_400_000).toISOString().slice(0, 10));
  const earliest = dates[0]!;
  const workspace = opts.workspace ?? null;
  const rows = db.prepare(
    `SELECT substr(tm.created_at, 1, 10) AS date,
            SUM(COALESCE(tm.tokens_in, 0)) AS tokensIn,
            SUM(COALESCE(tm.tokens_out, 0)) AS tokensOut
       FROM task_metric tm
       JOIN task t ON t.id = tm.task_id
       JOIN workspace w ON w.id = t.workspace_id
      WHERE tm.created_at >= ?
        AND (? IS NULL OR w.name = ?)
      GROUP BY substr(tm.created_at, 1, 10)
      ORDER BY date`
  ).all(earliest, workspace, workspace) as Array<{ date: string; tokensIn: number; tokensOut: number }>;
  const totals = new Map(rows.map((row) => [row.date, row]));
  return dates.map((date) => {
    const row = totals.get(date);
    return { date, tokensIn: row?.tokensIn ?? 0, tokensOut: row?.tokensOut ?? 0 };
  });
}
