import type { DB } from '../db.js';
import { deliveryExhaustionReported } from './retry.js';
import type { CiMode, DeliverySummary, DeliveryProvider, DeliveryPrState, DeliveryChecksState, DeliveryCheck, DeliveryFailingCheck, RevisionReadTicket, Status } from '../types.js';

export interface DeliveryRow {
  task_id: number; provider: DeliveryProvider; branch: string;
  pr_url: string | null; pr_id: string | null;
  pr_state: DeliveryPrState; checks_state: DeliveryChecksState;
  detail: string | null; checked_at: string | null; state_changed_at: string;
  created_at: string; updated_at: string;
  // migration #30: the approved submission/head, and the PR head the provider last reported
  submission_id: number | null; approved_head_sha: string | null; head_sha: string | null;
}

/** What a watcher poll observed — the delta applied by updateDeliveryObservation. */
export interface DeliveryObservation {
  /** The approval episode the watcher read before making its provider request. */
  expectedStateChangedAt?: string | undefined;
  /** Reject a slow poll if the task moved or its delivery was replaced in the meantime. */
  expected?: { status: Status; branch: string; prUrl: string | null; stateChangedAt: string } | undefined;
  prUrl?: string | null | undefined;
  prId?: string | null | undefined;
  prState: DeliveryPrState;
  checksState: DeliveryChecksState;
  /**
   * Which commit the checks describe: the PR head, or (with the watcher's postMergeChecks) the
   * merge commit. Only 'merge_commit' evidence is post-merge; absent means head.
   */
  checksTarget?: DeliveryChecksTarget | undefined;
  failing?: DeliveryFailingCheck[] | undefined;
  /** Every check the poll read, by name (passing ones too) � the provider's verification evidence. */
  checks?: DeliveryCheck[] | undefined;
  /** The workspace ciMode the watcher judged the checks under; absent or 'legacy' = every check counts. */
  ciMode?: CiMode | undefined;
  /** The PR's head commit as the provider reports it; undefined = not reported (keeps the stored one). */
  headSha?: string | null | undefined;
  /** When the watcher started the provider request, on its own clock: display only ("as of"). */
  readStartedAt?: string | undefined;
  /** The read ticket the watcher took from the board before its provider request: when a read that
   *  started later was already recorded (or the ticket is for another submission), the reported
   *  head is dropped and the rest of the answer kept. */
  readTicket?: RevisionReadTicket | undefined;
}

export type DeliveryChecksTarget = 'head' | 'merge_commit';

const CI_MODES_RECORDED = new Set<string>(['required', 'none']);

const CHECK_STATES = new Set<string>(['passing', 'pending', 'failing']);

/** The `detail` JSON: the checks holding the delivery up, every check read, plus a non-legacy ciMode (no column: #30 is the head). */
const parseDetail = (detail: string | null): { failing: DeliveryFailingCheck[]; checks?: DeliveryCheck[]; ciMode?: CiMode } => {
  if (!detail) return { failing: [] };
  try {
    const o = JSON.parse(detail) as { failing?: unknown; checks?: unknown; ciMode?: unknown };
    const failing = !Array.isArray(o.failing) ? [] : o.failing
      .filter((f): f is { name: string; url?: unknown; missing?: unknown } => typeof f === 'object' && f !== null && typeof (f as { name?: unknown }).name === 'string')
      .map((f) => ({ name: f.name, url: typeof f.url === 'string' ? f.url : null, ...(f.missing === true ? { missing: true } : {}) }));
    const checks = !Array.isArray(o.checks) ? undefined : o.checks
      .filter((c): c is { name: string; state: DeliveryCheck['state']; url?: unknown } => typeof c === 'object' && c !== null
        && typeof (c as { name?: unknown }).name === 'string' && CHECK_STATES.has((c as { state?: unknown }).state as string))
      .map((c) => ({ name: c.name, state: c.state, url: typeof c.url === 'string' ? c.url : null }));
    return {
      failing, ...(checks ? { checks } : {}),
      ...(typeof o.ciMode === 'string' && CI_MODES_RECORDED.has(o.ciMode) ? { ciMode: o.ciMode as CiMode } : {}),
    };
  } catch {
    return { failing: [] };
  }
};

const serializeDetail = (obs: Pick<DeliveryObservation, 'failing' | 'checks' | 'ciMode'>): string | null => {
  const failing = obs.failing && obs.failing.length > 0 ? obs.failing : null;
  const checks = obs.checks && obs.checks.length > 0 ? obs.checks.map((c) => ({ name: c.name, state: c.state, url: c.url })) : null;
  const ciMode = obs.ciMode && CI_MODES_RECORDED.has(obs.ciMode) ? obs.ciMode : null;
  if (!failing && !checks && !ciMode) return null;
  return JSON.stringify({ ...(failing ? { failing } : {}), ...(checks ? { checks } : {}), ...(ciMode ? { ciMode } : {}) });
};

export function toDeliverySummary(r: DeliveryRow): DeliverySummary {
  return {
    provider: r.provider, branch: r.branch,
    prUrl: r.pr_url, prId: r.pr_id,
    prState: r.pr_state, checksState: r.checks_state,
    ...parseDetail(r.detail),
    checkedAt: r.checked_at, stateChangedAt: r.state_changed_at,
    approvedHeadSha: r.approved_head_sha, headSha: r.head_sha, submissionId: r.submission_id,
  };
}

/** Seed (or reset — INSERT OR REPLACE, so a re-approval starts a fresh observation) the delivery row. */
export function upsertDelivery(db: DB, taskId: number, seed: { provider: DeliveryProvider; branch: string; prUrl: string | null; submissionId?: number | null; approvedHeadSha?: string | null }, ts: string): void {
  const previous = deliveryRowFor(db, taskId);
  // state_changed_at doubles as the watcher fence token. Keep it monotonic when a deterministic
  // test clock or a fast pair of approvals supplies the same timestamp for two episodes.
  const previousMs = previous ? Date.parse(previous.state_changed_at) : NaN;
  const requestedMs = Date.parse(ts);
  const episodeTs = previous && Number.isFinite(previousMs) && Number.isFinite(requestedMs) && requestedMs <= previousMs
    ? new Date(previousMs + 1).toISOString()
    : ts;
  db.prepare(
    `INSERT OR REPLACE INTO task_delivery
       (task_id, provider, branch, pr_url, pr_id, pr_state, checks_state, detail, checked_at, state_changed_at, created_at, updated_at, submission_id, approved_head_sha, head_sha)
     VALUES (?, ?, ?, ?, NULL, 'unknown', 'unknown', NULL, NULL, ?, ?, ?, ?, ?, NULL)`,
  ).run(taskId, seed.provider, seed.branch, seed.prUrl, episodeTs, episodeTs, episodeTs, seed.submissionId ?? null, seed.approvedHeadSha ?? null);
}

const DELIVERY_SELECT = 'SELECT d.* FROM task_delivery d';

export function deliveryRowFor(db: DB, taskId: number): DeliveryRow | undefined {
  return db.prepare(`${DELIVERY_SELECT} WHERE d.task_id = ?`).get(taskId) as DeliveryRow | undefined;
}

export function clearDelivery(db: DB, taskId: number): void {
  db.prepare('DELETE FROM task_delivery WHERE task_id = ?').run(taskId);
}

/** Batched delivery summaries per task id — mirrors aiReviewByTaskIds' one-query shape. */
export function deliveryByTaskIds(db: DB, ids: number[]): Map<number, DeliverySummary> {
  const out = new Map<number, DeliverySummary>();
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.prepare(`${DELIVERY_SELECT} WHERE d.task_id IN (${placeholders})`).all as (...a: any[]) => unknown)(...ids) as DeliveryRow[];
  for (const r of rows) out.set(r.task_id, { ...toDeliverySummary(r), repairExhausted: deliveryExhaustionReported(db, r.task_id) });
  return out;
}

/**
 * Apply one poll's observation. `checked_at` always advances; `state_changed_at` (and the
 * caller's task touch → getVersion bump) only when the observed state actually changed.
 * Returns whether it did.
 */
export function updateDeliveryObservation(db: DB, row: DeliveryRow, obs: DeliveryObservation, ts: string): { changed: boolean; accepted: boolean } {
  if (obs.expectedStateChangedAt !== undefined && obs.expectedStateChangedAt !== row.state_changed_at)
    return { changed: false, accepted: false };
  const prUrl = obs.prUrl !== undefined ? obs.prUrl : row.pr_url;
  const prId = obs.prId !== undefined ? obs.prId : row.pr_id;
  const detail = serializeDetail(obs);
  const headSha = obs.headSha !== undefined ? obs.headSha : row.head_sha;
  const changed =
    prUrl !== row.pr_url || prId !== row.pr_id ||
    obs.prState !== row.pr_state || obs.checksState !== row.checks_state ||
    detail !== row.detail || headSha !== row.head_sha;
  db.prepare(
    `UPDATE task_delivery SET pr_url = ?, pr_id = ?, pr_state = ?, checks_state = ?, detail = ?, head_sha = ?,
       checked_at = ?, state_changed_at = ?, updated_at = ?
     WHERE task_id = ?`,
  ).run(prUrl, prId, obs.prState, obs.checksState, detail, headSha, ts, changed ? ts : row.state_changed_at, ts, row.task_id);
  return { changed, accepted: true };
}
