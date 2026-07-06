import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

const patch = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'PATCH',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('workspaces REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  describe('GET /api/workspaces', () => {
    it('returns the seeded default workspace on a fresh DB', async () => {
      const res = await app.request('/api/workspaces');
      expect(res.status).toBe(200);
      const body = await res.json() as Array<{ name: string; repoPath: string }>;
      expect(body).toHaveLength(1);
      expect(body[0]).toMatchObject({ name: 'default', repoPath: '.' });
    });
  });

  describe('POST /api/workspaces', () => {
    it('creates a workspace with 201 and lists it', async () => {
      const res = await post(app, '/api/workspaces', { name: 'shopfloor', repoPath: 'c:\\Git\\Shopfloor' });
      expect(res.status).toBe(201);
      const ws = await res.json() as { name: string; repoPath: string };
      expect(ws).toMatchObject({ name: 'shopfloor', repoPath: 'c:\\Git\\Shopfloor' });

      const list = await (await app.request('/api/workspaces')).json() as Array<{ name: string }>;
      expect(list.map((w) => w.name)).toEqual(['default', 'shopfloor']);
    });

    it('duplicate name → 400', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/x' });
      const res = await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/y' });
      expect(res.status).toBe(400);
    });

    it('invalid slug → 400', async () => {
      const res = await post(app, '/api/workspaces', { name: 'My Repo', repoPath: '/x' });
      expect(res.status).toBe(400);
    });

    it('missing repoPath → 400', async () => {
      const res = await post(app, '/api/workspaces', { name: 'ok' });
      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /api/workspaces/:name — git PAT (write-only, masked)', () => {
    it('sets a PAT: response and GET expose only hasPat, never the raw value', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });

      const res = await patch(app, '/api/workspaces/repo-a', { pat: 'super-secret-token' });
      expect(res.status).toBe(200);
      const patched = await res.json() as Record<string, unknown>;
      expect(patched.hasPat).toBe(true);
      expect(patched.pat).toBeUndefined();

      const list = await app.request('/api/workspaces');
      const raw = await list.text(); // assert the secret is nowhere in the serialized payload
      expect(raw).not.toContain('super-secret-token');
      const repoA = (JSON.parse(raw) as Array<{ name: string; hasPat: boolean; pat?: unknown }>).find((w) => w.name === 'repo-a')!;
      expect(repoA.hasPat).toBe(true);
      expect(repoA.pat).toBeUndefined();
    });

    it('clears a PAT with { pat: null } → hasPat false', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      await patch(app, '/api/workspaces/repo-a', { pat: 'tok' });
      const cleared = await (await patch(app, '/api/workspaces/repo-a', { pat: null })).json() as { hasPat: boolean };
      expect(cleared.hasPat).toBe(false);
    });

    it('empty patch → 400', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      expect((await patch(app, '/api/workspaces/repo-a', {})).status).toBe(400);
    });
  });

  describe('PATCH /api/workspaces/:name — edit repoPath', () => {
    it('re-points an existing workspace to a new repoPath', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/old' });
      const res = await patch(app, '/api/workspaces/repo-a', { repoPath: '/new/location' });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ repoPath: '/new/location' });
      const list = await (await app.request('/api/workspaces')).json() as Array<{ name: string; repoPath: string }>;
      expect(list.find((w) => w.name === 'repo-a')?.repoPath).toBe('/new/location');
    });

    it('rejects a blank repoPath → 400', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/old' });
      expect((await patch(app, '/api/workspaces/repo-a', { repoPath: '   ' })).status).toBe(400);
    });
  });

  describe('PATCH /api/workspaces/:name — prompt overrides', () => {
    it('stores overrides (blanks dropped) and returns them on GET', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      const res = await patch(app, '/api/workspaces/repo-a', { promptOverrides: { reviewer: 'be strict', 'worker.plan': '   ' } });
      expect(res.status).toBe(200);
      expect((await res.json() as { promptOverrides: Record<string, string> }).promptOverrides).toEqual({ reviewer: 'be strict' });

      const list = await (await app.request('/api/workspaces')).json() as Array<{ name: string; promptOverrides: Record<string, string> }>;
      expect(list.find((w) => w.name === 'repo-a')?.promptOverrides).toEqual({ reviewer: 'be strict' });
    });

    it('rejects an unknown prompt key → 400', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      expect((await patch(app, '/api/workspaces/repo-a', { promptOverrides: { nope: 'x' } })).status).toBe(400);
    });
  });

  describe('agent-prompts REST API', () => {
    it('GET starts empty; PUT sets/merges/clears keys; GET reflects it', async () => {
      expect(await (await app.request('/api/agent-prompts')).json()).toEqual({});

      const put = async (b: unknown) => app.request('/api/agent-prompts', { method: 'PUT', body: JSON.stringify(b), headers: { 'content-type': 'application/json' } });
      await put({ reviewer: 'be strict', 'worker.plan': 'plan well' });
      expect(await (await app.request('/api/agent-prompts')).json()).toEqual({ reviewer: 'be strict', 'worker.plan': 'plan well' });

      // blank clears a key, merge keeps the other
      const res = await put({ 'worker.plan': '   ' });
      expect(await res.json()).toEqual({ reviewer: 'be strict' });
    });
  });

  describe('tasks API with workspaces', () => {
    it('POST /api/tasks passes workspace through; GET ?workspace= filters', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      const created = await post(app, '/api/tasks', { title: 'A1', spec: 's', acceptanceCriteria: 'a', workspace: 'repo-a' });
      expect(created.status).toBe(201);
      expect(await created.json()).toMatchObject({ workspace: 'repo-a' });
      await post(app, '/api/tasks', { title: 'D1', spec: 's', acceptanceCriteria: 'a' });

      const filtered = await (await app.request('/api/tasks?workspace=repo-a')).json() as Array<{ title: string }>;
      expect(filtered.map((t) => t.title)).toEqual(['A1']);

      const other = await (await app.request('/api/tasks?workspace=default')).json() as Array<{ title: string }>;
      expect(other.map((t) => t.title)).toEqual(['D1']);
    });

    it('unknown workspace on create → 404', async () => {
      const res = await post(app, '/api/tasks', { title: 'T', spec: 's', acceptanceCriteria: 'a', workspace: 'nope' });
      expect(res.status).toBe(404);
    });

    it('unknown workspace filter → 404', async () => {
      const res = await app.request('/api/tasks?workspace=nope');
      expect(res.status).toBe(404);
    });

    it('task detail carries workspace and repoPath', async () => {
      await post(app, '/api/workspaces', { name: 'repo-a', repoPath: '/a' });
      const created = await (await post(app, '/api/tasks', { title: 'T', spec: 's', acceptanceCriteria: 'a', workspace: 'repo-a' })).json() as { key: string };
      const detail = await (await app.request(`/api/tasks/${created.key}`)).json() as { workspace: string; repoPath: string };
      expect(detail).toMatchObject({ workspace: 'repo-a', repoPath: '/a' });
    });
  });
});
