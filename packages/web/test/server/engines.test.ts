import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const put = (app: ReturnType<typeof buildApp>, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

describe('engines REST API — board-wide engine availability', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('GET /api/engines defaults to every engine enabled', async () => {
    const res = await app.request('/api/engines');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: { enabled: true }, codex: { enabled: true } });
  });

  it('PUT /api/engines merges a partial toggle and returns the full set', async () => {
    const res = await put(app, '/api/engines', { codex: { enabled: false } });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ claude: { enabled: true }, codex: { enabled: false } });
    expect(core.getEngineSettings().codex.enabled).toBe(false);
  });

  it('PUT /api/engines rejects unknown engines and non-boolean values → 400', async () => {
    expect((await put(app, '/api/engines', { gemini: { enabled: false } })).status).toBe(400);
    expect((await put(app, '/api/engines', { codex: { enabled: 'off' } })).status).toBe(400);
  });

  it('a service token may read but never write the toggles', async () => {
    const tokenApp = buildApp(core, { auth: { mode: 'token' } });
    const service = core.createApiToken({ label: 'worker', isService: true }).token;
    const auth = { authorization: `Bearer ${service}` };
    const read = await tokenApp.request('/api/agent/engines', { headers: auth });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual({ claude: { enabled: true }, codex: { enabled: true } });
    const write = await put(tokenApp, '/api/engines', { codex: { enabled: false } }, auth);
    expect(write.status).toBe(403);
    expect(core.getEngineSettings().codex.enabled).toBe(true);
  });
});
