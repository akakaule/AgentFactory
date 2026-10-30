import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { spendByDay } from '../src/ops/spendByDay.js';
import { createCore } from '../src/index.js';

const NOW = '2026-10-15T12:00:00.000Z';
const now = () => NOW;

describe('spendByDay', () => {
  it('is empty for a month without usage and defaults to the current UTC month', () => {
    const db = makeTestDb();

    expect(createCore(db).spendByDay).toBeTypeOf('function');
    expect(spendByDay(db, {}, now)).toEqual({ month: '2026-10', dataUpTo: null, rows: [] });
    expect(spendByDay(db, { month: '2026-09' }, now)).toEqual({ month: '2026-09', dataUpTo: null, rows: [] });
  });

  it('sums cost, tokens, and unpriced tokens per day, workspace, and model inside the UTC month', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 100, tokensOut: 10, costUsd: 1.5 }, () => '2026-10-01T00:00:00.000Z');
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 50, costUsd: 0.5 }, () => '2026-10-01T23:30:00.000Z');
    addTaskMetrics(db, task.key, { model: 'gpt-6.1-sol', tokensIn: 30, tokensOut: 3, costUsd: 0.25 }, () => '2026-10-01T10:00:00.000Z');
    addTaskMetrics(db, task.key, { model: 'gpt-6.1-sol', tokensIn: 70, tokensOut: 7 }, () => '2026-10-01T11:00:00.000Z'); // unpriced
    addTaskMetrics(db, task.key, { tokensIn: 5 }, () => '2026-10-31T23:59:59.999Z'); // no model, last instant of the month
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 999, costUsd: 9 }, () => '2026-09-30T23:59:59.999Z'); // previous month
    addTaskMetrics(db, task.key, { model: 'claude-opus-5-5', tokensIn: 999, costUsd: 9 }, () => '2026-11-01T00:00:00.000Z'); // next month

    const spend = spendByDay(db, { month: '2026-10' }, now);

    expect(spend.month).toBe('2026-10');
    expect(spend.dataUpTo).toBe('2026-10-31T23:59:59.999Z');
    expect(spend.rows).toEqual([
      { date: '2026-10-01', workspace: 'default', model: 'claude-opus-5-5', costUsd: 2, tokens: 160, unpricedTokens: 0 },
      { date: '2026-10-01', workspace: 'default', model: 'gpt-6.1-sol', costUsd: 0.25, tokens: 110, unpricedTokens: 77 },
      { date: '2026-10-31', workspace: 'default', model: null, costUsd: 0, tokens: 5, unpricedTokens: 5 },
    ]);
  });

  it('filters by workspace name, including unknown, empty, and literal all', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'other', repoPath: '/other' });
    createWorkspace(db, { name: 'all', repoPath: '/all' });
    const defaultTask = createTask(db, { title: 'Default', spec: 'S', acceptanceCriteria: 'A' });
    const otherTask = createTask(db, { title: 'Other', spec: 'S', acceptanceCriteria: 'A', workspace: 'other' });
    const allTask = createTask(db, { title: 'All', spec: 'S', acceptanceCriteria: 'A', workspace: 'all' });
    addTaskMetrics(db, defaultTask.key, { tokensIn: 10, costUsd: 1 }, () => '2026-10-10T01:00:00.000Z');
    addTaskMetrics(db, otherTask.key, { tokensIn: 20, costUsd: 2 }, () => '2026-10-10T02:00:00.000Z');
    addTaskMetrics(db, allTask.key, { tokensIn: 40, costUsd: 4 }, () => '2026-10-11T03:00:00.000Z');

    const cost = (workspace?: string) => spendByDay(db, workspace === undefined ? {} : { workspace }, now)
      .rows.reduce((sum, r) => sum + r.costUsd, 0);

    expect(cost()).toBe(7);
    expect(cost('default')).toBe(1);
    expect(cost('other')).toBe(2);
    expect(cost('all')).toBe(4);
    expect(cost('missing')).toBe(0);
    expect(cost('')).toBe(0);
    expect(spendByDay(db, { workspace: 'other' }, now).dataUpTo).toBe('2026-10-10T02:00:00.000Z');
  });
});
