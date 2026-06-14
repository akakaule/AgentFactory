import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const postJson = (body: unknown, t?: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify(body),
});

function liveTask(core: ReturnType<typeof openCore>) {
  const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  return t;
}

describe('GET /api/agents', () => {
  it('lists currently-running agents joined to their task', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = liveTask(core);
    core.reportProgress(t.key, { message: 'running build', tokensIn: 500 });

    const res = await app.request('/api/agents');
    expect(res.status).toBe(200);
    const live = (await res.json()) as Array<{ key: string; phase: string; label: string; status: string; tokensIn: number }>;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ key: t.key, phase: 'running build', label: 'worker-1', status: 'in_progress', tokensIn: 500 });
  });

  it('is empty once the agent submits', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = liveTask(core);
    core.submitResult(t.key, { summary: 'done' });
    expect(await (await app.request('/api/agents')).json()).toHaveLength(0);
  });
});

describe('POST /api/agents heartbeat + end', () => {
  it('a heartbeat with a message records a milestone; /:key/end clears the session', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = liveTask(core);

    const hb = await app.request('/api/agents/heartbeat', postJson({ key: t.key, message: 'cloning repo' }));
    expect(hb.status).toBe(204);
    const after = (await (await app.request('/api/agents')).json()) as Array<{ phase: string }>;
    expect(after[0]!.phase).toBe('cloning repo');

    const end = await app.request(`/api/agents/${t.key}/end`, { method: 'POST' });
    expect(end.status).toBe(204);
    expect(await (await app.request('/api/agents')).json()).toHaveLength(0);
  });
});

describe('auth (token mode)', () => {
  it('401s without a token, 200 with a (service) token', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    const token = core.createApiToken({ label: 'runner', isService: true }).token;
    liveTask(core);
    expect((await app.request('/api/agents')).status).toBe(401);
    expect((await app.request('/api/agents', bearer(token))).status).toBe(200);
  });
});
