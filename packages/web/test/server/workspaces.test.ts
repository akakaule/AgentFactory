import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
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
