import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { getVersion } from '../src/version.js';
import { createTask } from '../src/ops/createTask.js';
import { updateTask } from '../src/ops/updateTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { addComment } from '../src/ops/addComment.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { createCore } from '../src/index.js';

// Helper to count activity rows in the DB
function countActivity(db: ReturnType<typeof makeTestDb>): number {
  return (db.prepare('SELECT COUNT(*) n FROM activity').get() as { n: number }).n;
}

describe('invariants: every mutating op advances getVersion and tracks activity', () => {
  it('createTask: advances version and adds one activity row', () => {
    const db = makeTestDb();
    const ts = '2026-01-01T00:00:00.000Z';
    createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts);
    expect(getVersion(db)).toBe(ts);
    expect(countActivity(db)).toBe(1);
  });

  it('updateStatus (backlog→queued, human): advances version and adds one activity row', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    const before = countActivity(db);
    updateStatus(db, task.key, 'queued', 'human', () => ts2);
    expect(getVersion(db)).toBe(ts2);
    expect(countActivity(db)).toBe(before + 1);
  });

  it('claimNextTask: advances version and adds one activity row', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const ts3 = '2026-01-03T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    updateStatus(db, task.key, 'queued', 'human', () => ts2);
    const before = countActivity(db);
    claimNextTask(db, undefined, () => ts3);
    expect(getVersion(db)).toBe(ts3);
    expect(countActivity(db)).toBe(before + 1);
  });

  it('addComment: advances version and adds one activity row', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    const before = countActivity(db);
    addComment(db, task.key, { actor: 'agent', body: 'hello' }, () => ts2);
    expect(getVersion(db)).toBe(ts2);
    expect(countActivity(db)).toBe(before + 1);
  });

  it('submitResult: advances version and adds activity rows', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const ts3 = '2026-01-03T00:00:00.000Z';
    const ts4 = '2026-01-04T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    updateStatus(db, task.key, 'queued', 'human', () => ts2);
    claimNextTask(db, undefined, () => ts3);
    const before = countActivity(db);
    submitResult(db, task.key, { summary: 'done!' }, () => ts4);
    expect(getVersion(db)).toBe(ts4);
    expect(countActivity(db)).toBeGreaterThan(before);
  });

  it('reviewApprove: advances version and adds one activity row', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const ts3 = '2026-01-03T00:00:00.000Z';
    const ts4 = '2026-01-04T00:00:00.000Z';
    const ts5 = '2026-01-05T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    updateStatus(db, task.key, 'queued', 'human', () => ts2);
    claimNextTask(db, undefined, () => ts3);
    submitResult(db, task.key, { summary: 'done!' }, () => ts4);
    const before = countActivity(db);
    reviewApprove(db, task.key, () => ts5);
    expect(getVersion(db)).toBe(ts5);
    expect(countActivity(db)).toBe(before + 1);
  });

  it('reviewRequestChanges: advances version and adds activity rows', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const ts3 = '2026-01-03T00:00:00.000Z';
    const ts4 = '2026-01-04T00:00:00.000Z';
    const ts5 = '2026-01-05T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    updateStatus(db, task.key, 'queued', 'human', () => ts2);
    claimNextTask(db, undefined, () => ts3);
    submitResult(db, task.key, { summary: 'done!' }, () => ts4);
    const before = countActivity(db);
    reviewRequestChanges(db, task.key, { feedback: 'needs work' }, () => ts5);
    expect(getVersion(db)).toBe(ts5);
    expect(countActivity(db)).toBeGreaterThan(before);
  });

  it('updateTask: bumps version (via updated_at) but adds NO activity row', () => {
    const db = makeTestDb();
    const ts1 = '2026-01-01T00:00:00.000Z';
    const ts2 = '2026-01-02T00:00:00.000Z';
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => ts1);
    const before = countActivity(db);
    updateTask(db, task.key, { title: 'Updated title' }, () => ts2);
    expect(getVersion(db)).toBe(ts2);
    // updateTask must NOT add any activity row
    expect(countActivity(db)).toBe(before);
  });
});

describe('createCore wiring', () => {
  it('binds all ops to the db and getVersion returns a string', () => {
    const db = makeTestDb();
    const core = createCore(db);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(core.getTask(t.key).key).toBe(t.key);
    expect(typeof core.getVersion()).toBe('string');
  });
});
