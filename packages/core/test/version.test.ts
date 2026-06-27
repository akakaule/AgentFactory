import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { getVersion } from '../src/version.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';
import { deleteTask } from '../src/ops/deleteTask.js';
import { appendLiveBuf, saveFinal } from '../src/repo/transcripts.js';

// version format: "<max timestamp>#<task count>" — the count makes deletions visible
// (a DELETE can never raise the max, but it always changes the count).

describe('getVersion', () => {
  it('returns the seeded default workspace epoch on an otherwise empty DB', () => {
    const db = makeTestDb();
    // migration #2 seeds the default workspace with a fixed epoch created_at,
    // so a fresh DB's version is the sentinel, not ''
    expect(getVersion(db)).toBe('1970-01-01T00:00:00.000Z#0');
  });

  it('returns the task updatedAt after createTask', () => {
    const db = makeTestDb();
    const ts = '2026-01-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts);
    expect(getVersion(db)).toBe(`${ts}#1`);
    expect(getVersion(db)).toBe(`${task.updatedAt}#1`);
  });

  it('advances to the later addComment timestamp', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-02-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    addComment(db, task.key, { actor: 'agent', body: 'x' }, () => ts2);
    expect(getVersion(db)).toBe(`${ts2}#1`);
  });

  it('equals max(max task.updated_at, max activity.created_at) computed directly', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-02-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    addComment(db, task.key, { actor: 'agent', body: 'x' }, () => ts2);

    const maxTask = (db.prepare('SELECT MAX(updated_at) v FROM task').get() as { v: string }).v;
    const maxActivity = (db.prepare('SELECT MAX(created_at) v FROM activity').get() as { v: string }).v;
    const expected = maxTask > maxActivity ? maxTask : maxActivity;

    expect(getVersion(db)).toBe(`${expected}#1`);
  });

  it('is unaffected by transcript writes (task_transcript is outside the change signal)', () => {
    const db = makeTestDb();
    const ts = '2026-01-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts);
    const id = (db.prepare('SELECT id FROM task WHERE key = ?').get(task.key) as { id: number }).id;
    const before = getVersion(db);
    // a live append and the final persist must both leave the board version untouched, the way
    // agent_session / supervisor_heartbeat writes do — frequent tails must never refetch the board.
    appendLiveBuf(db, { taskId: id, attempt: 1, sessionId: 's', engine: 'claude', chunk: '{"a":1}\n', now: '2027-01-01T00:00:00.000Z' });
    expect(getVersion(db)).toBe(before);
    saveFinal(db, { taskId: id, attempt: 1, sessionId: 's', engine: 'claude', raw: '{"a":1}\n', now: '2027-02-01T00:00:00.000Z' });
    expect(getVersion(db)).toBe(before);
  });

  it('changes when a task that is NOT the newest row is deleted', () => {
    const db = makeTestDb();
    const old = createTask(db, { title: 'Old', spec: 'S', acceptanceCriteria: 'A' }, () => '2026-01-01T00:00:00.000Z');
    createTask(db, { title: 'New', spec: 'S', acceptanceCriteria: 'A' }, () => '2026-02-01T00:00:00.000Z');
    const before = getVersion(db);

    deleteTask(db, old.key);

    expect(getVersion(db)).not.toBe(before);
  });
});
