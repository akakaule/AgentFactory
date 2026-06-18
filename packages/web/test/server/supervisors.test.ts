import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });

describe('GET /api/supervisors', () => {
  it('lists supervisors with a derived healthy flag', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    core.recordSupervisorHeartbeat({ name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 1, capacity: 2, pollSeconds: 15 });

    const res = await app.request('/api/supervisors');
    expect(res.status).toBe(200);
    const sup = (await res.json()) as Array<{ name: string; kind: string; healthy: boolean; inFlight: number; workspaces: string[] }>;
    expect(sup).toHaveLength(1);
    expect(sup[0]).toMatchObject({ name: 'dispatcher', kind: 'dispatcher', healthy: true, inFlight: 1, workspaces: ['default'] });
  });

  it('is empty before any supervisor has reported', async () => {
    const app = buildApp(openCore(':memory:'));
    expect(await (await app.request('/api/supervisors')).json()).toHaveLength(0);
  });

  it('is guarded by /api/* auth in token mode', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    const token = core.createApiToken({ label: 'ui', isService: true }).token;
    expect((await app.request('/api/supervisors')).status).toBe(401);
    expect((await app.request('/api/supervisors', bearer(token))).status).toBe(200);
  });
});

describe('GET /health', () => {
  it('is a public liveness probe (no auth even in token mode) and returns the board version', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    const res = await app.request('/health');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string };
    expect(body.ok).toBe(true);
    expect(typeof body.version).toBe('string');
  });
});
