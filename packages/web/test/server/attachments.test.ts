import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 8, 7]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

describe('attachments over HTTP', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let key: string;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
    key = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' }).key;
  });

  it('POST stores the image; GET round-trips the exact bytes with the right type', async () => {
    const res = await post(app, `/api/tasks/${key}/attachments`, { filename: 'shot.png', mime: 'image/png', dataBase64: PNG_B64 });
    expect(res.status).toBe(201);
    const meta = await res.json() as { id: number; filename: string; size: number };
    expect(meta).toMatchObject({ filename: 'shot.png', size: PNG_BYTES.length });

    const bin = await app.request(`/api/attachments/${meta.id}`);
    expect(bin.status).toBe(200);
    expect(bin.headers.get('content-type')).toBe('image/png');
    expect(bin.headers.get('cache-control')).toContain('immutable');
    const body = new Uint8Array(await bin.arrayBuffer());
    expect(Buffer.from(body).equals(Buffer.from(PNG_BYTES))).toBe(true);
  });

  it('DELETE removes it; subsequent GET → 404', async () => {
    const meta = await (await post(app, `/api/tasks/${key}/attachments`, { filename: 'a.png', mime: 'image/png', dataBase64: PNG_B64 })).json() as { id: number };

    expect((await app.request(`/api/attachments/${meta.id}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/attachments/${meta.id}`)).status).toBe(404);
  });

  it('rejects attachments outside backlog with 409', async () => {
    core.updateStatus(key, 'queued', 'human');
    const res = await post(app, `/api/tasks/${key}/attachments`, { filename: 'a.png', mime: 'image/png', dataBase64: PNG_B64 });
    expect(res.status).toBe(409);
  });

  it('attachment bytes disappear with the task (end to end over HTTP)', async () => {
    const meta = await (await post(app, `/api/tasks/${key}/attachments`, { filename: 'a.png', mime: 'image/png', dataBase64: PNG_B64 })).json() as { id: number };
    expect((await app.request(`/api/tasks/${key}`, { method: 'DELETE' })).status).toBe(204);
    expect((await app.request(`/api/attachments/${meta.id}`)).status).toBe(404);
  });

  it('rejects bad mime with 400 and unknown ids with 404', async () => {
    expect((await post(app, `/api/tasks/${key}/attachments`, { filename: 'a.pdf', mime: 'application/pdf', dataBase64: PNG_B64 })).status).toBe(400);
    expect((await post(app, '/api/tasks/AF-9999/attachments', { filename: 'a.png', mime: 'image/png', dataBase64: PNG_B64 })).status).toBe(404);
    expect((await app.request('/api/attachments/9999')).status).toBe(404);
    expect((await app.request('/api/attachments/9999', { method: 'DELETE' })).status).toBe(404);
  });
});
