import type { DB } from '../db.js';
import type { SupervisorKind } from '../types.js';

/**
 * Repo primitives for the `supervisor_heartbeat` current-state table (one row per supervisor,
 * keyed by name). Like agent_session these don't touch task.updated_at, so getVersion() is
 * unaffected — health is polled via /api/supervisors, not the board version signal. They run
 * inside a caller's transaction (ops/supervisorHeartbeat.ts).
 */

export interface SupervisorRow {
  name: string; kind: SupervisorKind; workspaces: string; in_flight: number; capacity: number;
  poll_seconds: number | null; polls: number; version: string | null; started_at: string; last_seen_at: string;
}

export interface UpsertSupervisor {
  name: string; kind: SupervisorKind; workspaces: string[];
  inFlight: number; capacity: number; pollSeconds?: number | null; version?: string | null;
}

/**
 * Upsert a supervisor's heartbeat (by name): first beat inserts (polls = 1, started_at = now),
 * every later beat refreshes the live fields, increments the cumulative poll count, and bumps
 * last_seen_at — while preserving the original started_at.
 */
export function upsertSupervisor(db: DB, s: UpsertSupervisor, now: string): void {
  db.prepare(
    `INSERT INTO supervisor_heartbeat (name, kind, workspaces, in_flight, capacity, poll_seconds, polls, version, started_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET
       kind = excluded.kind, workspaces = excluded.workspaces, in_flight = excluded.in_flight,
       capacity = excluded.capacity, poll_seconds = excluded.poll_seconds, version = excluded.version,
       polls = supervisor_heartbeat.polls + 1, last_seen_at = excluded.last_seen_at`,
  ).run(s.name, s.kind, s.workspaces.join(','), s.inFlight, s.capacity, s.pollSeconds ?? null, s.version ?? null, now, now);
}

export function selectSupervisors(db: DB): SupervisorRow[] {
  return db.prepare('SELECT * FROM supervisor_heartbeat ORDER BY kind, name').all() as unknown as SupervisorRow[];
}
