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
