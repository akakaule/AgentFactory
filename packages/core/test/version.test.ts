import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { getVersion } from '../src/version.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';

describe('getVersion', () => {
  it('returns the seeded default workspace epoch on an otherwise empty DB', () => {
    const db = makeTestDb();
    // migration #2 seeds the default workspace with a fixed epoch created_at,
    // so a fresh DB's version is the sentinel, not ''
    expect(getVersion(db)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('returns the task updatedAt after createTask', () => {
    const db = makeTestDb();
    const ts = '2026-01-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts);
    expect(getVersion(db)).toBe(ts);
    expect(getVersion(db)).toBe(task.updatedAt);
  });

  it('advances to the later addComment timestamp', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-02-01T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    addComment(db, task.key, { actor: 'agent', body: 'x' }, () => ts2);
    expect(getVersion(db)).toBe(ts2);
    expect(getVersion(db) > ts1).toBe(true);
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

    expect(getVersion(db)).toBe(expected);
  });
});
