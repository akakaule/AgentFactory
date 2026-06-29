import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

const prBody = {
  title: 'PR #42: fix the thing',
  spec: 'Review teammate PR',
  acceptanceCriteria: 'review given',
  kind: 'pr-review',
  links: [
    { kind: 'pr', label: 'PR #42', url: 'https://github.com/o/r/pull/42' },
    { kind: 'branch', label: 'feature/teammate-thing', url: 'https://github.com/o/r/pull/42' },
  ],
};

describe('pr-review tasks over HTTP', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('POST /api/tasks with kind=pr-review + links → 201, detail carries kind + links', async () => {
    const created = await (await post(app, '/api/tasks', prBody)).json() as { key: string; kind: string };
    expect(created.kind).toBe('pr-review');

    const detail = await (await app.request(`/api/tasks/${created.key}`)).json() as { kind: string; links: Array<{ kind: string; label: string }> };
    expect(detail.kind).toBe('pr-review');
    expect(detail.links.map((l) => l.kind)).toEqual(['pr', 'branch']);
  });

  it('a pr-review task parks straight into review; a code task on the same move → 400', async () => {
    const pr = await (await post(app, '/api/tasks', prBody)).json() as { key: string };
    const parked = await post(app, `/api/tasks/${pr.key}/status`, { status: 'in_review' });
    expect(parked.status).toBe(200);
    expect((await parked.json() as { status: string }).status).toBe('in_review');

    const code = await (await post(app, '/api/tasks', { title: 'T', spec: 'S', acceptanceCriteria: 'A' })).json() as { key: string };
    expect((await post(app, `/api/tasks/${code.key}/status`, { status: 'in_review' })).status).toBe(400);
  });

  it('approving an in_review pr-review task closes it (Mark reviewed → done)', async () => {
    const pr = await (await post(app, '/api/tasks', prBody)).json() as { key: string };
    await post(app, `/api/tasks/${pr.key}/status`, { status: 'in_review' });
    const res = await post(app, `/api/tasks/${pr.key}/approve`, {});
    expect(res.status).toBe(200);
    expect((await res.json() as { status: string }).status).toBe('done');
  });
});
