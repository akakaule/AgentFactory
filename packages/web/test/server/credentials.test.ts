import { describe, it, expect, beforeEach, vi } from 'vitest';
import { openCore, type CredentialCheck } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const ORIGIN = 'https://dev.azure.com/org/proj/_git/repo';

describe('credential health routes', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let next: CredentialCheck;
  const probe = vi.fn(async () => next);

  beforeEach(() => {
    probe.mockClear();
    next = { status: 'failing', error: "fatal: Authentication failed for '" + ORIGIN + "/'", expiresAt: null };
    core = openCore(':memory:', { resolveOrigin: (repoPath) => (repoPath === '/ado' ? ORIGIN : null), probeCredential: probe });
    app = buildApp(core);
    core.createWorkspace({ name: 'ado', repoPath: '/ado' });
    core.updateWorkspace('ado', { pat: 'secret-pat' });
  });

  it('checks a workspace credential now and lists the recorded health', async () => {
    const res = await app.request('/api/workspaces/ado/credential-check', { method: 'POST' });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ credential: { workspace: 'ado', state: 'failing', status: 'failing' } });
    expect(probe).toHaveBeenCalledTimes(1);

    const list = await (await app.request('/api/credential-health')).json() as Array<{ workspace: string; state: string; error: string | null }>;
    expect(list).toEqual([expect.objectContaining({ workspace: 'ado', state: 'failing' })]);
    expect(JSON.stringify(list)).not.toContain('secret-pat');
  });

  it('answers credential: null for a workspace without a managed credential', async () => {
    const res = await app.request('/api/workspaces/default/credential-check', { method: 'POST' });
    expect(await res.json()).toEqual({ credential: null });
    expect(probe).not.toHaveBeenCalled();
  });

  it('returns 404 for an unknown workspace', async () => {
    expect((await app.request('/api/workspaces/nope/credential-check', { method: 'POST' })).status).toBe(404);
  });

  it('lets only humans run a check', async () => {
    const tokenApp = buildApp(core, { auth: { mode: 'token' } });
    const service = core.createApiToken({ label: 'worker', isService: true }).token;
    expect((await tokenApp.request('/api/workspaces/ado/credential-check', { method: 'POST', headers: { authorization: `Bearer ${service}` } })).status).toBe(403);
  });
});
