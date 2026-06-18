import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { activitySince, latestActivityId } from '../src/repo/activity.js';
import { getKv, setKv } from '../src/repo/kv.js';
import { getVersion } from '../src/version.js';

describe('activitySince feed', () => {
  it('returns global activity since a cursor, joined to task key + workspace, oldest first', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Build', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, t.key, 'queued', 'human');

    const all = activitySince(db, 0);
    expect(all.length).toBeGreaterThanOrEqual(1);
    expect(all[0]).toMatchObject({ taskKey: t.key, taskTitle: 'Build', workspace: 'default' });
    expect(all.map((r) => r.id)).toEqual([...all.map((r) => r.id)].sort((a, b) => a - b)); // ascending

    // a cursor at the latest id yields nothing until new activity lands
    const hwm = latestActivityId(db);
    expect(activitySince(db, hwm)).toHaveLength(0);
    updateStatus(db, t.key, 'in_progress', 'agent');
    const next = activitySince(db, hwm);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ type: 'status_change', toStatus: 'in_progress' });
  });
});

describe('app_kv store', () => {
  it('round-trips a value and upserts in place', () => {
    const db = makeTestDb();
    expect(getKv(db, 'notify_cursor')).toBeNull();
    setKv(db, 'notify_cursor', '7');
    expect(getKv(db, 'notify_cursor')).toBe('7');
    setKv(db, 'notify_cursor', '42');
    expect(getKv(db, 'notify_cursor')).toBe('42');
  });

  it('does not bump getVersion() (kv is outside the board change signal)', () => {
    const db = makeTestDb();
    const before = getVersion(db);
    setKv(db, 'notify_cursor', '99');
    expect(getVersion(db)).toBe(before);
  });
});
