import { describe, it, expect } from 'vitest';
import { tasksForColumn } from '../../client/src/status.js';
import type { Task } from '../../client/src/types.js';

const t = (over: Partial<Task> = {}): Task => ({
  id: 1, key: 'AF-1', title: 'T', spec: '', acceptanceCriteria: '',
  status: 'done', stage: 'implementation', kind: 'code', resultSummary: null, seq: 1,
  workspace: 'default', claimedBy: null, claimedAt: null, archivedAt: null,
  aiReview: null, failure: null, delivery: null, unmetDependencyCount: 0,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z', ...over,
});

describe('tasksForColumn', () => {
  it('orders Done newest-first by updatedAt regardless of seq', () => {
    const tasks = [
      t({ key: 'AF-1', seq: 1, status: 'done', updatedAt: '2026-06-01T10:00:00.000Z' }),
      t({ key: 'AF-2', seq: 2, status: 'done', updatedAt: '2026-06-03T10:00:00.000Z' }),
      t({ key: 'AF-3', seq: 3, status: 'done', updatedAt: '2026-06-02T10:00:00.000Z' }),
    ];
    expect(tasksForColumn('done', tasks).map((x) => x.key)).toEqual(['AF-2', 'AF-3', 'AF-1']);
  });

  it('filters to the requested status', () => {
    const tasks = [
      t({ key: 'AF-1', status: 'done' }),
      t({ key: 'AF-2', status: 'queued' }),
    ];
    expect(tasksForColumn('done', tasks).map((x) => x.key)).toEqual(['AF-1']);
  });

  it('preserves seq order for non-Done columns', () => {
    const tasks = [
      t({ key: 'AF-1', seq: 1, status: 'queued', updatedAt: '2026-06-01T10:00:00.000Z' }),
      t({ key: 'AF-2', seq: 2, status: 'queued', updatedAt: '2026-06-03T10:00:00.000Z' }),
      t({ key: 'AF-3', seq: 3, status: 'queued', updatedAt: '2026-06-02T10:00:00.000Z' }),
    ];
    expect(tasksForColumn('queued', tasks).map((x) => x.key)).toEqual(['AF-1', 'AF-2', 'AF-3']);
  });

  it('does not mutate the input array', () => {
    const tasks = [
      t({ key: 'AF-1', status: 'done', updatedAt: '2026-06-01T10:00:00.000Z' }),
      t({ key: 'AF-2', status: 'done', updatedAt: '2026-06-03T10:00:00.000Z' }),
    ];
    tasksForColumn('done', tasks);
    expect(tasks.map((x) => x.key)).toEqual(['AF-1', 'AF-2']);
  });
});
