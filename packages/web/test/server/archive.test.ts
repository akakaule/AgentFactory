import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });

describe('archive REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  function makeDone(workspace?: string): string {
    const task = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', ...(workspace ? { workspace } : {}) });
    core.updateStatus(task.key, 'queued', 'human');
    core.claimNextTask(workspace ? { workspace } : {});
    core.submitResult(task.key, { summary: 'done' });
    core.reviewApprove(task.key);
    return task.key;
  }

  it('POST /:key/archive on a done task → 200; task leaves the default listing', async () => {
    const key = makeDone();

    const res = await post(app, `/api/tasks/${key}/archive`, {});
    expect(res.status).toBe(200);
    const body = await res.json() as { archivedAt: string | null; status: string };
    expect(body.archivedAt).not.toBeNull();
    expect(body.status).toBe('done');

    const list = await (await app.request('/api/tasks')).json() as unknown[];
    expect(list).toHaveLength(0);
  });

  it('GET /api/tasks?archived=true lists only archived tasks', async () => {
    const key = makeDone();
    core.createTask({ title: 'Active', spec: 'S', acceptanceCriteria: 'A' });
    await post(app, `/api/tasks/${key}/archive`, {});

    const res = await app.request('/api/tasks?archived=true');
    expect(res.status).toBe(200);
    const body = await res.json() as Array<{ key: string }>;
    expect(body.map((t) => t.key)).toEqual([key]);
  });

  it('POST /:key/archive on a non-done task → 409', async () => {
    const task = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect((await post(app, `/api/tasks/${task.key}/archive`, {})).status).toBe(409);
  });

  it('POST /:key/archive on an unknown task → 404', async () => {
    expect((await post(app, '/api/tasks/AF-9999/archive', {})).status).toBe(404);
  });

  it('POST /:key/unarchive restores the task to the default listing', async () => {
    const key = makeDone();
    await post(app, `/api/tasks/${key}/archive`, {});

    const res = await post(app, `/api/tasks/${key}/unarchive`, {});
    expect(res.status).toBe(200);
    expect(((await res.json()) as { archivedAt: string | null }).archivedAt).toBeNull();

    const list = await (await app.request('/api/tasks')).json() as Array<{ key: string }>;
    expect(list.map((t) => t.key)).toEqual([key]);
  });

  it('POST /:key/unarchive on a non-archived task → 409', async () => {
    const key = makeDone();
    expect((await post(app, `/api/tasks/${key}/unarchive`, {})).status).toBe(409);
  });

  it('POST /archive-done archives every done task; non-terminal tasks stay', async () => {
    makeDone();
    makeDone();
    const open = core.createTask({ title: 'Open', spec: 'S', acceptanceCriteria: 'A' });

    const res = await post(app, '/api/tasks/archive-done', {});
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 2 });

    const list = await (await app.request('/api/tasks')).json() as Array<{ key: string }>;
    expect(list.map((t) => t.key)).toEqual([open.key]);
  });

  it('POST /archive-done with a workspace only archives that workspace', async () => {
    core.createWorkspace({ name: 'other', repoPath: '/tmp/other' });
    const inDefault = makeDone();
    makeDone('other');

    const res = await post(app, '/api/tasks/archive-done', { workspace: 'other' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ archived: 1 });

    const list = await (await app.request('/api/tasks')).json() as Array<{ key: string }>;
    expect(list.map((t) => t.key)).toEqual([inDefault]);
  });

  it('POST /archive-done with an unknown workspace → 404', async () => {
    expect((await post(app, '/api/tasks/archive-done', { workspace: 'nope' })).status).toBe(404);
  });

  it('archived task detail stays reachable by key with its data intact', async () => {
    const key = makeDone();
    await post(app, `/api/tasks/${key}/archive`, {});

    const res = await app.request(`/api/tasks/${key}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { archivedAt: string | null; spec: string; activity: unknown[] };
    expect(body.archivedAt).not.toBeNull();
    expect(body.spec).toBe('S');
    expect(body.activity.length).toBeGreaterThan(0);
  });
});
