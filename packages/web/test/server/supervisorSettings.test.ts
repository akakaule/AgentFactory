import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const put = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('supervisor-settings REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('GET returns all three kinds (empty on a fresh DB)', async () => {
    const res = await app.request('/api/supervisor-settings');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ dispatcher: {}, reviewer: {}, watcher: {} });
  });

  it('PUT persists one kind; GET reflects it', async () => {
    const res = await put(app, '/api/supervisor-settings/dispatcher', { maxConcurrent: 4, stageEngines: { implementation: 'codex' } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ maxConcurrent: 4, stageEngines: { implementation: 'codex' } });
    const all = (await (await app.request('/api/supervisor-settings')).json()) as Record<string, unknown>;
    expect(all['dispatcher']).toEqual({ maxConcurrent: 4, stageEngines: { implementation: 'codex' } });
    expect(all['reviewer']).toEqual({});
  });

  it('rejects an unknown supervisor kind (404)', async () => {
    const res = await put(app, '/api/supervisor-settings/orchestrator', { pollSeconds: 5 });
    expect(res.status).toBe(404);
  });

  it('rejects an unknown field, a secret sub-key, and a bad value (400 via core ValidationError)', async () => {
    expect((await put(app, '/api/supervisor-settings/dispatcher', { db: '/x' })).status).toBe(400);
    expect((await put(app, '/api/supervisor-settings/dispatcher', { otel: { token: 'x' } })).status).toBe(400);
    expect((await put(app, '/api/supervisor-settings/reviewer', { maxConcurrent: -1 })).status).toBe(400);
  });
});
