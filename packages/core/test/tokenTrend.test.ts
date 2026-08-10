import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { tokenTrend } from '../src/ops/tokenTrend.js';
import { createCore } from '../src/index.js';

const NOW = '2026-08-10T12:00:00.000Z';
const now = () => NOW;

describe('tokenTrend', () => {
  it('returns exactly 30 chronological UTC days, zero-filled when no metrics exist', () => {
    const db = makeTestDb();

    const points = tokenTrend(db, {}, now);

    expect(createCore(db).tokenTrend).toBeTypeOf('function');
    expect(points).toHaveLength(30);
    expect(points[0]).toEqual({ date: '2026-07-12', tokensIn: 0, tokensOut: 0 });
    expect(points[29]).toEqual({ date: '2026-08-10', tokensIn: 0, tokensOut: 0 });
    expect(points.map((point) => point.date)).toEqual(
      Array.from({ length: 30 }, (_, index) => {
        const date = new Date('2026-07-12T00:00:00.000Z');
        date.setUTCDate(date.getUTCDate() + index);
        return date.toISOString().slice(0, 10);
      }),
    );
  });

  it('buckets by metric creation date, including 23:30Z, and sums input/output separately', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => '2026-07-19T00:00:00.000Z');
    updateStatus(db, task.key, 'queued', 'human', () => '2026-07-19T01:00:00.000Z');
    claimNextTask(db, {}, () => '2026-07-19T02:00:00.000Z');
    addTaskMetrics(db, task.key, { tokensIn: 100, tokensOut: 10 }, () => '2026-07-20T23:30:00.000Z');
    addTaskMetrics(db, task.key, { tokensIn: 50 }, () => '2026-07-20T23:45:00.000Z');
    addTaskMetrics(db, task.key, { tokensOut: 7 }, () => '2026-07-20T23:59:59.999Z');
    submitResult(db, task.key, { summary: 'done' }, () => '2026-08-08T00:00:00.000Z');
    reviewApprove(db, task.key, () => '2026-08-09T00:00:00.000Z', null, () => null);

    const points = tokenTrend(db, {}, now);

    expect(points.find((point) => point.date === '2026-07-20')).toEqual({
      date: '2026-07-20', tokensIn: 150, tokensOut: 17,
    });
    expect(points.find((point) => point.date === '2026-08-09')).toEqual({
      date: '2026-08-09', tokensIn: 0, tokensOut: 0,
    });
  });

  it('includes the -29 day boundary and excludes reports from -30 days', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, task.key, { tokensIn: 29 }, () => '2026-07-12T00:00:00.000Z');
    addTaskMetrics(db, task.key, { tokensIn: 30 }, () => '2026-07-11T23:59:59.999Z');

    expect(tokenTrend(db, {}, now)[0]).toEqual({ date: '2026-07-12', tokensIn: 29, tokensOut: 0 });
    expect(tokenTrend(db, {}, now).reduce((sum, point) => sum + point.tokensIn, 0)).toBe(29);
  });

  it('aggregates without a workspace and filters known, unknown, empty, and literal all workspaces', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'other', repoPath: '/other' });
    createWorkspace(db, { name: 'all', repoPath: '/all' });
    const defaultTask = createTask(db, { title: 'Default', spec: 'S', acceptanceCriteria: 'A' });
    const otherTask = createTask(db, { title: 'Other', spec: 'S', acceptanceCriteria: 'A', workspace: 'other' });
    const allTask = createTask(db, { title: 'All', spec: 'S', acceptanceCriteria: 'A', workspace: 'all' });
    addTaskMetrics(db, defaultTask.key, { tokensIn: 10, tokensOut: 1 }, () => '2026-08-10T01:00:00.000Z');
    addTaskMetrics(db, otherTask.key, { tokensIn: 20, tokensOut: 2 }, () => '2026-08-10T02:00:00.000Z');
    addTaskMetrics(db, allTask.key, { tokensIn: 40, tokensOut: 4 }, () => '2026-08-10T03:00:00.000Z');

    const totals = (workspace?: string) => {
      const points = workspace === undefined ? tokenTrend(db, {}, now) : tokenTrend(db, { workspace }, now);
      return points.reduce(
        (sum, point) => ({ tokensIn: sum.tokensIn + point.tokensIn, tokensOut: sum.tokensOut + point.tokensOut }),
        { tokensIn: 0, tokensOut: 0 },
      );
    };

    expect(totals()).toEqual({ tokensIn: 70, tokensOut: 7 });
    expect(totals('default')).toEqual({ tokensIn: 10, tokensOut: 1 });
    expect(totals('other')).toEqual({ tokensIn: 20, tokensOut: 2 });
    expect(totals('missing')).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(totals('')).toEqual({ tokensIn: 0, tokensOut: 0 });
    expect(totals('all')).toEqual({ tokensIn: 40, tokensOut: 4 });
  });
});
