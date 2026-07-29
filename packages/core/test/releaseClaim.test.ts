import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import type { DB } from '../src/db.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { releaseClaim } from '../src/ops/releaseClaim.js';
import { listLiveAgents } from '../src/ops/agentSession.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';

const FIXED_TS = '2030-09-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

function claimed(db: DB) {
  const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, t.key, 'queued', 'human');
  claimNextTask(db, { claimedBy: 'worker-1' });
  return t;
}

describe('releaseClaim (system recovery action)', () => {
  it('releases an in_progress claim: queued, claimant cleared, live session ended', () => {
    const db = makeTestDb();
    const t = claimed(db);
    expect(listLiveAgents(db)).toHaveLength(1);

    const detail = releaseClaim(db, t.key, fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.claimedBy).toBeNull();
    expect(detail.claimedAt).toBeNull();
    expect(listLiveAgents(db)).toHaveLength(0);

    const row = findRowByKey(db, t.key)!;
    expect(row.status).toBe('queued');
    expect(row.updated_at).toBe(FIXED_TS);
  });

  it('stamps the release as a system action in the activity trail', () => {
    const db = makeTestDb();
    const t = claimed(db);

    const detail = releaseClaim(db, t.key, fixedNow);

    const release = detail.activity.filter((a) => a.type === 'status_change').at(-1)!;
    expect(release).toMatchObject({ fromStatus: 'in_progress', toStatus: 'queued', actor: 'human' });
    expect(release.body).toContain('system-reap');
  });

  it('throws InvalidTransitionError when the task is not in_progress (race lost — leave as-is)', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, t.key, 'queued', 'human');

    expect(() => releaseClaim(db, t.key, fixedNow)).toThrow(InvalidTransitionError);
    expect(findRowByKey(db, t.key)!.status).toBe('queued');
  });

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();
    expect(() => releaseClaim(db, 'AF-9999', fixedNow)).toThrow(NotFoundError);
  });
});
