import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const html = '<html><body><h1>Change</h1><script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script></body></html>';

const postHtml = (app: ReturnType<typeof buildApp>, path: string, body: string) =>
  app.request(path, { method: 'POST', body, headers: { 'content-type': 'text/html' } });

describe('visualization REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let key: string;

  beforeEach(async () => {
    core = openCore(':memory:');
    app = buildApp(core);
    key = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' }).key;
  });

  it('GET before any attach → 404', async () => {
    expect((await app.request(`/api/tasks/${key}/visualization`)).status).toBe(404);
  });

  it('POST stores the HTML, then GET serves it back as text/html', async () => {
    const post = await postHtml(app, `/api/tasks/${key}/visualization`, html);
    expect(post.status).toBe(201);
    const body = await post.json() as { ok: boolean; bytes: number; generatedAt: string };
    expect(body).toMatchObject({ ok: true, bytes: html.length });
    expect(body.generatedAt).toBeTruthy(); // HttpCore.attachVisualization builds its meta from this

    const get = await app.request(`/api/tasks/${key}/visualization`);
    expect(get.status).toBe(200);
    expect(get.headers.get('content-type')).toContain('text/html');
    expect(await get.text()).toBe(html);
  });

  it('attaching flips TaskDetail.hasVisualization', async () => {
    const before = await (await app.request(`/api/tasks/${key}`)).json() as { hasVisualization: boolean };
    expect(before.hasVisualization).toBe(false);

    await postHtml(app, `/api/tasks/${key}/visualization`, html);

    const after = await (await app.request(`/api/tasks/${key}`)).json() as { hasVisualization: boolean; visualizationGeneratedAt: string | null };
    expect(after.hasVisualization).toBe(true);
    expect(after.visualizationGeneratedAt).toBeTruthy();
  });

  it('empty body → 400', async () => {
    expect((await postHtml(app, `/api/tasks/${key}/visualization`, '   ')).status).toBe(400);
  });

  it('oversized body → 400', async () => {
    const huge = '<html>' + 'x'.repeat(4 * 1024 * 1024);
    expect((await postHtml(app, `/api/tasks/${key}/visualization`, huge)).status).toBe(400);
  });

  it('POST to an unknown task → 404', async () => {
    expect((await postHtml(app, '/api/tasks/AF-9999/visualization', html)).status).toBe(404);
  });

  // Pins deliberate behavior: the board-mode reviewer supervisor attaches auto-generated
  // visualizations with a plain service token — this route must NOT gain rejectService.
  it('a service token may attach (board-mode reviewer)', async () => {
    const authed = openCore(':memory:');
    const authedApp = buildApp(authed, { auth: { mode: 'token' } });
    const k = authed.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' }).key;
    const svc = authed.createApiToken({ label: 'reviewer', isService: true }).token;

    const res = await authedApp.request(`/api/tasks/${k}/visualization`, {
      method: 'POST',
      body: html,
      headers: { 'content-type': 'text/html', authorization: `Bearer ${svc}` },
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { generatedAt: string }).generatedAt).toBeTruthy();
  });
});
