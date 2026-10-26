import { describe, it, expect, beforeEach } from 'vitest';
import { openCore, type DiagnoseProbes } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

/** Workspace repository profile (effective values + where each comes from) and the human-only,
 *  read-only diagnose route. Everything external is stubbed: no real git, PATH or host calls. */

const SECRET = 'ghp_ROUTESECRET987';
const patch = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
type Profile = { baseBranch: { value: string | null; source: string }; requiredChecks: { value: string[]; source: string }; ciMode: { value: string; source: string } };
type WsView = { name: string; baseBranch: string | null; requiredChecks: string[] | null; ciMode: string | null; profile: Profile };
const list = async (app: ReturnType<typeof buildApp>) => (await (await app.request('/api/workspaces')).json()) as WsView[];

const stubProbes = (): DiagnoseProbes => ({
  platform: 'linux',
  env: { PATH: '/usr/bin' },
  async exec(file, args) {
    if (args[0] === '--version') return { ok: true, stdout: `${file} 1.0`, missing: false };
    if (args[0] === 'remote') return { ok: true, stdout: `https://user:${SECRET}@github.com/acme/app.git`, missing: false };
    if (args[0] === 'symbolic-ref') return { ok: true, stdout: 'refs/remotes/origin/main', missing: false };
    return { ok: false, stdout: '', missing: false };
  },
  realPath: (p) => p,
  fileExists: (p) => p === '/usr/bin/npm',
  isExecutable: (p) => p === '/usr/bin/npm',
  fetch: async () => ({ status: 200 }),
});

describe('workspaces — repository profile', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let detectCalls: string[];

  beforeEach(() => {
    core = openCore(':memory:');
    detectCalls = [];
    app = buildApp(core, {
      resolveOrigin: () => null,
      detectBaseBranch: async (p) => { detectCalls.push(p); return p === '/app' ? 'main' : null; },
      diagnoseProbes: stubProbes(),
    });
    core.createWorkspace({ name: 'app', repoPath: '/app' });
  });

  it('an unconfigured workspace serves the legacy defaults with the base branch detected', async () => {
    const ws = (await list(app)).find((w) => w.name === 'app')!;
    expect(ws).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
    expect(ws.profile).toEqual({
      baseBranch: { value: 'main', source: 'detected' },
      requiredChecks: { value: [], source: 'default' },
      ciMode: { value: 'legacy', source: 'default' },
    });
    expect((await list(app)).find((w) => w.name === 'default')!.profile.baseBranch).toEqual({ value: null, source: 'unresolved' });
  });

  it('PATCH stores the profile; configured values are served as configured and skip detection', async () => {
    const res = await patch(app, '/api/workspaces/app', { baseBranch: 'develop', requiredChecks: ['build', 'test'], ciMode: 'required' });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WsView).profile).toEqual({
      baseBranch: { value: 'develop', source: 'configured' },
      requiredChecks: { value: ['build', 'test'], source: 'configured' },
      ciMode: { value: 'required', source: 'configured' },
    });
    detectCalls = [];
    await list(app);
    expect(detectCalls).not.toContain('/app');
  });

  it('PATCH rejects an invalid ciMode or base branch with 400', async () => {
    expect((await patch(app, '/api/workspaces/app', { ciMode: 'sometimes' })).status).toBe(400);
    expect((await patch(app, '/api/workspaces/app', { baseBranch: '-rf' })).status).toBe(400);
  });

  it('caches the base-branch detection per repo path between requests', async () => {
    await list(app);
    const after = detectCalls.length;
    await list(app);
    expect(detectCalls.length).toBe(after);
  });
});

describe('workspaces — diagnose', () => {
  let core: ReturnType<typeof openCore>;

  beforeEach(() => {
    core = openCore(':memory:');
    core.createWorkspace({ name: 'app', repoPath: '/app' });
    core.updateWorkspace('app', { pat: SECRET, verifyCommand: 'npm test' });
  });

  it('GET /:name/diagnose reports every check with a status and reason and never leaks a secret', async () => {
    const app = buildApp(core, { diagnoseProbes: stubProbes() });
    const res = await app.request('/api/workspaces/app/diagnose');
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { workspace: string; checks: Array<{ id: string; status: string; reason: string }> };
    expect(body.workspace).toBe('app');
    expect(body.checks.map((c) => c.id)).toEqual(['repo_path', 'git', 'node', 'origin', 'base_ref', 'verify_command', 'pat', 'host_checks']);
    for (const c of body.checks) {
      expect(['ok', 'failed', 'not_applicable']).toContain(c.status);
      expect(c.reason).not.toBe('');
    }
    expect(body.checks.find((c) => c.id === 'host_checks')!.status).toBe('ok');
  });

  it('is 404 for an unknown workspace', async () => {
    const app = buildApp(core, { diagnoseProbes: stubProbes() });
    expect((await app.request('/api/workspaces/nope/diagnose')).status).toBe(404);
  });

  it('is human-only: a service token is refused', async () => {
    const app = buildApp(core, { auth: { mode: 'token' }, diagnoseProbes: stubProbes() });
    const service = core.createApiToken({ label: 'reviewer', isService: true }).token;
    const res = await app.request('/api/workspaces/app/diagnose', { headers: { authorization: `Bearer ${service}` } });
    expect(res.status).toBe(403);
  });
});
