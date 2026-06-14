import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import type { DB } from '../src/db.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reportProgress, touchAgentSession, endAgentSession, listLiveAgents } from '../src/ops/agentSession.js';
import { getVersion } from '../src/version.js';

function queued(db: DB) {
  const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, t.key, 'queued', 'human');
  return t;
}

describe('agent_session live tracking', () => {
  it('claim starts a live session; listLiveAgents surfaces it', () => {
    const db = makeTestDb();
    const t = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    const live = listLiveAgents(db);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ key: t.key, label: 'worker-1', status: 'in_progress', stage: 'implementation' });
    expect(live[0]!.phase).toBeNull();
  });

  it('reportProgress sets the phase, appends to the rolling feed, and records tokens', () => {
    const db = makeTestDb();
    const t = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    reportProgress(db, t.key, { message: 'writing tests', tokensIn: 1000, tokensOut: 200 });
    reportProgress(db, t.key, { message: 'running build' });

    const live = listLiveAgents(db)[0]!;
    expect(live.phase).toBe('running build');
    expect(live.recent.map((r) => r.msg)).toEqual(['writing tests', 'running build']);
    expect(live.tokensIn).toBe(1000); // retained via COALESCE when a later call omits tokens
    expect(live.tokensOut).toBe(200);
  });

  it('submit ends the session (drops it from the live view)', () => {
    const db = makeTestDb();
    const t = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });
    expect(listLiveAgents(db)).toHaveLength(1);

    submitResult(db, t.key, { summary: 'done' });
    expect(listLiveAgents(db)).toHaveLength(0);
  });

  it('endAgentSession is an idempotent crash safety-net (agent never submitted)', () => {
    const db = makeTestDb();
    const t = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    endAgentSession(db, t.key);
    expect(listLiveAgents(db)).toHaveLength(0);
    expect(() => endAgentSession(db, t.key)).not.toThrow();
  });

  it('reportProgress no-ops on an unclaimed task and throws on an unknown key', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }); // backlog, no live session
    expect(() => reportProgress(db, t.key, { message: 'x' })).not.toThrow();
    expect(listLiveAgents(db)).toHaveLength(0);
    expect(() => reportProgress(db, 'AF-9999', { message: 'x' })).toThrow();
  });

  it('heartbeat/progress writes do NOT bump getVersion() (no board-refetch thrash)', () => {
    const db = makeTestDb();
    const t = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    const v = getVersion(db);
    reportProgress(db, t.key, { message: 'still working' });
    touchAgentSession(db, t.key);
    expect(getVersion(db)).toBe(v); // agent_session is outside getVersion()'s tables
  });
});
