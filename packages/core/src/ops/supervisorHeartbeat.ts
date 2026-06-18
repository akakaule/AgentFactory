import type { DB } from '../db.js';
import type { SupervisorView } from '../types.js';
import { transaction } from '../transaction.js';
import { upsertSupervisor, selectSupervisors, type UpsertSupervisor } from '../repo/supervisors.js';
import { nowIso } from '../time.js';

/** A supervisor is healthy if it beat within this many of its own poll intervals. */
export const HEALTHY_MISSED_POLLS = 3;
/** Staleness window (seconds) when a supervisor didn't report its poll interval. */
export const DEFAULT_STALE_SECONDS = 90;

/** Record (upsert) a supervisor's heartbeat. Called by the dispatcher/reviewer each poll. */
export function recordSupervisorHeartbeat(db: DB, input: UpsertSupervisor, now: () => string = nowIso): void {
  transaction(db, () => upsertSupervisor(db, input, now()));
}

/**
 * Every known supervisor with a derived `healthy` flag: a supervisor is healthy while it has
 * beaten within HEALTHY_MISSED_POLLS of its own poll interval (or DEFAULT_STALE_SECONDS when it
 * didn't report one). A crashed/killed supervisor stops beating and flips unhealthy on its own.
 */
export function listSupervisors(db: DB, now: () => string = nowIso): SupervisorView[] {
  const t = Date.parse(now());
  return selectSupervisors(db).map((r) => {
    const staleMs = Math.max(0, t - Date.parse(r.last_seen_at));
    const thresholdSec = r.poll_seconds ? r.poll_seconds * HEALTHY_MISSED_POLLS : DEFAULT_STALE_SECONDS;
    return {
      name: r.name, kind: r.kind, workspaces: r.workspaces ? r.workspaces.split(',') : [],
      inFlight: r.in_flight, capacity: r.capacity, pollSeconds: r.poll_seconds, polls: r.polls,
      version: r.version, startedAt: r.started_at, lastSeenAt: r.last_seen_at,
      healthy: staleMs < thresholdSec * 1000,
      staleSeconds: Math.round(staleMs / 1000),
    };
  });
}
