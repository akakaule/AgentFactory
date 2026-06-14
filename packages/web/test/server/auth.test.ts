import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const postJson = (t: string | null, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(t ? { authorization: `Bearer ${t}` } : {}) },
  body: JSON.stringify(body),
});

describe('auth: none mode (default — unchanged local behavior)', () => {
  it('allows API access without a token and reports anon', async () => {
    const app = buildApp(openCore(':memory:'));
    expect((await app.request('/api/tasks')).status).toBe(200);
    expect(await (await app.request('/auth/whoami')).json()).toEqual({ kind: 'anon' });
  });
});

describe('auth: token mode', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let token: string;
  let userId: number;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core, { auth: { mode: 'token' } });
    userId = core.createUser({ email: 'alvin@example.com', displayName: 'Alvin' }).id;
    token = core.createApiToken({ label: 'test', userId }).token;
  });

  it('401s on /api without a token', async () => {
    expect((await app.request('/api/tasks')).status).toBe(401);
  });

  it('401s on /api with an unknown token', async () => {
    expect((await app.request('/api/tasks', bearer('not-a-real-token'))).status).toBe(401);
  });

  it('200s on /api with a valid token', async () => {
    expect((await app.request('/api/tasks', bearer(token))).status).toBe(200);
  });

  it('guards /events (EventSource) too', async () => {
    expect((await app.request('/events')).status).toBe(401);
  });

  it('whoami reports the user behind a valid token', async () => {
    const who = await (await app.request('/auth/whoami', bearer(token))).json();
    expect(who).toMatchObject({ kind: 'user', userId, email: 'alvin@example.com', displayName: 'Alvin' });
  });

  it('whoami reports anon for a missing token (never 401s)', async () => {
    expect(await (await app.request('/auth/whoami')).json()).toEqual({ kind: 'anon' });
  });

  it('a service token resolves to a service principal', async () => {
    const svc = core.createApiToken({ label: 'ado-bridge', isService: true }).token;
    expect(await (await app.request('/auth/whoami', bearer(svc))).json()).toEqual({ kind: 'service', label: 'ado-bridge' });
    expect((await app.request('/api/tasks', bearer(svc))).status).toBe(200);
  });

  it('attributes a human approve over HTTP to the token user', async () => {
    const created = await (await app.request('/api/tasks', postJson(token, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }))).json() as { key: string };
    // walk to in_review the legal way, then approve via HTTP with the user's token
    core.updateStatus(created.key, 'queued', 'human');
    core.claimNextTask();
    core.submitResult(created.key, { summary: 'done' });

    expect((await app.request(`/api/tasks/${created.key}/approve`, { method: 'POST', ...bearer(token) })).status).toBe(200);

    const detail = await (await app.request(`/api/tasks/${created.key}`, bearer(token))).json() as {
      activity: Array<{ type: string; toStatus: string | null; actorUserId: number | null; actorName: string | null }>;
    };
    const done = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'done')!;
    expect(done.actorUserId).toBe(userId);
    expect(done.actorName).toBe('Alvin');
  });
});
