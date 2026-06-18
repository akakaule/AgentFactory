import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { recordSupervisorHeartbeat, listSupervisors } from '../src/ops/supervisorHeartbeat.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (sec: number) => () => new Date(BASE + sec * 1000).toISOString();

describe('supervisor heartbeat', () => {
  it('records a supervisor and reports it healthy right after a beat', () => {
    const db = makeTestDb();
    recordSupervisorHeartbeat(db, { name: 'dispatcher', kind: 'dispatcher', workspaces: ['default', 'repo-a'], inFlight: 1, capacity: 2, pollSeconds: 15 }, at(0));
    const [s] = listSupervisors(db, at(5));
    expect(s).toMatchObject({
      name: 'dispatcher', kind: 'dispatcher', workspaces: ['default', 'repo-a'],
      inFlight: 1, capacity: 2, pollSeconds: 15, polls: 1, healthy: true, staleSeconds: 5,
    });
  });

  it('upserts by name: increments polls, refreshes live fields, preserves started_at', () => {
    const db = makeTestDb();
    recordSupervisorHeartbeat(db, { name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 0, capacity: 1, pollSeconds: 15 }, at(0));
    recordSupervisorHeartbeat(db, { name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 2, capacity: 1, pollSeconds: 15 }, at(15));
    const [s] = listSupervisors(db, at(16));
    expect(s!.polls).toBe(2);
    expect(s!.inFlight).toBe(2);
    expect(s!.startedAt).toBe(at(0)());
    expect(s!.lastSeenAt).toBe(at(15)());
  });

  it('flips unhealthy once it stops beating beyond 3× its poll interval', () => {
    const db = makeTestDb();
    recordSupervisorHeartbeat(db, { name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 0, capacity: 1, pollSeconds: 15 }, at(0));
    expect(listSupervisors(db, at(44))[0]!.healthy).toBe(true);  // < 45s (3×15)
    expect(listSupervisors(db, at(46))[0]!.healthy).toBe(false); // > 45s
  });

  it('falls back to a default staleness window when no poll interval was reported', () => {
    const db = makeTestDb();
    recordSupervisorHeartbeat(db, { name: 'r', kind: 'reviewer', workspaces: ['default'], inFlight: 0, capacity: 1 }, at(0));
    expect(listSupervisors(db, at(89))[0]!.healthy).toBe(true);  // < 90s default
    expect(listSupervisors(db, at(91))[0]!.healthy).toBe(false);
  });

  it('tracks dispatcher and reviewer as distinct rows', () => {
    const db = makeTestDb();
    recordSupervisorHeartbeat(db, { name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 0, capacity: 1, pollSeconds: 15 }, at(0));
    recordSupervisorHeartbeat(db, { name: 'reviewer', kind: 'reviewer', workspaces: ['default'], inFlight: 0, capacity: 1, pollSeconds: 60 }, at(0));
    const all = listSupervisors(db, at(1));
    expect(all.map((s) => s.kind).sort()).toEqual(['dispatcher', 'reviewer']);
  });
});
