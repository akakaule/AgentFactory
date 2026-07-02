import type { DB } from '../db.js';
import type { DeliverySummary, DeliveryProvider, DeliveryPrState, DeliveryChecksState, DeliveryFailingCheck } from '../types.js';

export interface DeliveryRow {
  task_id: number; provider: DeliveryProvider; branch: string;
  pr_url: string | null; pr_id: string | null;
  pr_state: DeliveryPrState; checks_state: DeliveryChecksState;
  detail: string | null; checked_at: string | null; state_changed_at: string;
  created_at: string; updated_at: string;
}

/** What a watcher poll observed — the delta applied by updateDeliveryObservation. */
export interface DeliveryObservation {
  prUrl?: string | null | undefined;
  prId?: string | null | undefined;
  prState: DeliveryPrState;
  checksState: DeliveryChecksState;
  failing?: DeliveryFailingCheck[] | undefined;
}

const parseFailing = (detail: string | null): DeliveryFailingCheck[] => {
  if (!detail) return [];
  try {
    const o = JSON.parse(detail) as { failing?: unknown };
    if (!Array.isArray(o.failing)) return [];
    return o.failing
      .filter((f): f is { name: string; url?: unknown } => typeof f === 'object' && f !== null && typeof (f as { name?: unknown }).name === 'string')
      .map((f) => ({ name: f.name, url: typeof f.url === 'string' ? f.url : null }));
  } catch {
    return [];
  }
};

export function toDeliverySummary(r: DeliveryRow): DeliverySummary {
  return {
    provider: r.provider, branch: r.branch,
    prUrl: r.pr_url, prId: r.pr_id,
    prState: r.pr_state, checksState: r.checks_state,
    failing: parseFailing(r.detail),
    checkedAt: r.checked_at, stateChangedAt: r.state_changed_at,
  };
}

/** Seed (or reset — INSERT OR REPLACE, so a re-approval starts a fresh observation) the delivery row. */
export function upsertDelivery(db: DB, taskId: number, seed: { provider: DeliveryProvider; branch: string; prUrl: string | null }, ts: string): void {
  db.prepare(
    `INSERT OR REPLACE INTO task_delivery
       (task_id, provider, branch, pr_url, pr_id, pr_state, checks_state, detail, checked_at, state_changed_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, NULL, 'unknown', 'unknown', NULL, NULL, ?, ?, ?)`,
  ).run(taskId, seed.provider, seed.branch, seed.prUrl, ts, ts, ts);
}

export function deliveryRowFor(db: DB, taskId: number): DeliveryRow | undefined {
  return db.prepare('SELECT * FROM task_delivery WHERE task_id = ?').get(taskId) as DeliveryRow | undefined;
}

/** Batched delivery summaries per task id — mirrors aiReviewByTaskIds' one-query shape. */
export function deliveryByTaskIds(db: DB, ids: number[]): Map<number, DeliverySummary> {
  const out = new Map<number, DeliverySummary>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.prepare(`SELECT * FROM task_delivery WHERE task_id IN (${placeholders})`).all as (...a: any[]) => unknown)(...ids) as DeliveryRow[];
  for (const r of rows) out.set(r.task_id, toDeliverySummary(r));
  return out;
}

/**
 * Apply one poll's observation. `checked_at` always advances; `state_changed_at` (and the
 * caller's task touch → getVersion bump) only when the observed state actually changed.
 * Returns whether it did.
 */
export function updateDeliveryObservation(db: DB, row: DeliveryRow, obs: DeliveryObservation, ts: string): { changed: boolean } {
  const prUrl = obs.prUrl !== undefined ? obs.prUrl : row.pr_url;
  const prId = obs.prId !== undefined ? obs.prId : row.pr_id;
  const detail = obs.failing && obs.failing.length > 0 ? JSON.stringify({ failing: obs.failing }) : null;
  const changed =
    prUrl !== row.pr_url || prId !== row.pr_id ||
    obs.prState !== row.pr_state || obs.checksState !== row.checks_state ||
    detail !== row.detail;
  db.prepare(
    `UPDATE task_delivery SET pr_url = ?, pr_id = ?, pr_state = ?, checks_state = ?, detail = ?,
       checked_at = ?, state_changed_at = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(prUrl, prId, obs.prState, obs.checksState, detail, ts, changed ? ts : row.state_changed_at, ts, row.task_id);
  return { changed };
}
