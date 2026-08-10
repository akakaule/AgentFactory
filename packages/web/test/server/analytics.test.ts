import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('GET /api/analytics', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('returns per-task rows and stranded releases for a driven loop', async () => {
    // done task with metrics
    const t1 = core.createTask({ title: 'T1', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t1.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'worker-1' });
    core.submitResult(t1.key, { summary: 'done' });
    core.reviewApprove(t1.key);
    core.addTaskMetrics(t1.key, { model: 'claude-fable-5', tokensIn: 1000, tokensOut: 200, costUsd: 0.05 });

    // stranded release on a second task
    const t2 = core.createTask({ title: 'T2', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t2.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'worker-2' });
    core.updateStatus(t2.key, 'queued', 'human'); // release

    const res = await app.request('/api/analytics');
    expect(res.status).toBe(200);
    const body = await res.json() as {
      tasks: Array<{ key: string; status: string; worker: string | null; tokensIn: number | null; rounds: number }>;
      stranded: Array<{ worker: string | null; workspace: string }>;
    };

    const row1 = body.tasks.find((t) => t.key === t1.key)!;
    expect(row1).toMatchObject({ status: 'done', worker: 'worker-1', tokensIn: 1000, rounds: 0 });
    expect(body.stranded).toHaveLength(1);
    expect(body.stranded[0]).toMatchObject({ worker: 'worker-2', workspace: 'default' });
  });
});

describe('GET /api/analytics/token-trend', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
    core.createWorkspace({ name: 'other', repoPath: '/other' });
    core.createWorkspace({ name: 'all', repoPath: '/all' });
    const defaultTask = core.createTask({ title: 'Default', spec: 'S', acceptanceCriteria: 'A' });
    const otherTask = core.createTask({ title: 'Other', spec: 'S', acceptanceCriteria: 'A', workspace: 'other' });
    const allTask = core.createTask({ title: 'All', spec: 'S', acceptanceCriteria: 'A', workspace: 'all' });
    core.addTaskMetrics(defaultTask.key, { tokensIn: 10, tokensOut: 1 });
    core.addTaskMetrics(otherTask.key, { tokensIn: 20, tokensOut: 2 });
    core.addTaskMetrics(allTask.key, { tokensIn: 40, tokensOut: 4 });
  });

  const totals = (points: Array<{ tokensIn: number; tokensOut: number }>) => points.reduce(
    (sum, point) => ({ tokensIn: sum.tokensIn + point.tokensIn, tokensOut: sum.tokensOut + point.tokensOut }),
    { tokensIn: 0, tokensOut: 0 },
  );

  it('aggregates when absent and treats default, other, and literal all as real workspace filters', async () => {
    const aggregate = await (await app.request('/api/analytics/token-trend')).json() as Array<{ date: string; tokensIn: number; tokensOut: number }>;
    const defaultOnly = await (await app.request('/api/analytics/token-trend?workspace=default')).json() as Array<{ date: string; tokensIn: number; tokensOut: number }>;
    const otherOnly = await (await app.request('/api/analytics/token-trend?workspace=other')).json() as Array<{ date: string; tokensIn: number; tokensOut: number }>;
    const allOnly = await (await app.request('/api/analytics/token-trend?workspace=all')).json() as Array<{ date: string; tokensIn: number; tokensOut: number }>;

    expect(aggregate).toHaveLength(30);
    expect(aggregate.every((point) => Object.keys(point).sort().join(',') === 'date,tokensIn,tokensOut')).toBe(true);
    expect(totals(aggregate)).toEqual({ tokensIn: 70, tokensOut: 7 });
    expect(totals(defaultOnly)).toEqual({ tokensIn: 10, tokensOut: 1 });
    expect(totals(otherOnly)).toEqual({ tokensIn: 20, tokensOut: 2 });
    expect(totals(allOnly)).toEqual({ tokensIn: 40, tokensOut: 4 });
  });
});

describe('POST /api/tasks/:key/metrics', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'worker-1' });
  });

  it('records a report → 201 with the updated detail', async () => {
    const res = await post(app, '/api/tasks/AF-1/metrics', { model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92, reportedBy: 'wrapper' });
    expect(res.status).toBe(201);
    const body = await res.json() as { metrics: { tokensIn: number; model: string } };
    expect(body.metrics).toMatchObject({ tokensIn: 41000, model: 'claude-fable-5' });
  });

  it('unknown task → 404', async () => {
    expect((await post(app, '/api/tasks/AF-9999/metrics', { tokensIn: 1 })).status).toBe(404);
  });

  it('empty report → 400', async () => {
    expect((await post(app, '/api/tasks/AF-1/metrics', {})).status).toBe(400);
    expect((await post(app, '/api/tasks/AF-1/metrics', { reportedBy: 'wrapper' })).status).toBe(400);
  });
});
