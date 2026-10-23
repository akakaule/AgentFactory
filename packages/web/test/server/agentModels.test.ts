import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const put = (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/agent-models', { method: 'PUT', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

const profile = (model: string) => ({ global: { stages: { description: { engine: 'claude', model } } }, workspaces: {} });

describe('agent-models REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    core.createWorkspace({ name: 'kl-dis', repoPath: '/r' });
    app = buildApp(core);
  });

  it('GET returns the settings, the reported defaults and the catalogue', async () => {
    core.reportAgentModelDefaults({ supervisor: 'dispatcher', kind: 'dispatcher', roles: { stages: { implementation: { engine: 'claude' } } } });
    const res = await app.request('/api/agent-models');
    expect(res.status).toBe(200);
    const body = await res.json() as { settings: unknown; defaults: Record<string, unknown>; catalog: Array<{ id: string }> };
    expect(body.settings).toEqual({ global: {}, workspaces: {} });
    expect(Object.keys(body.defaults)).toEqual(['dispatcher']);
    expect(body.catalog.map((m) => m.id)).toContain('gpt-6.1-sol');
  });

  it('PUT replaces the whole document', async () => {
    const doc = {
      global: { reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }] },
      workspaces: { 'kl-dis': { stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } } } },
    };
    const res = await put(app, doc);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { settings: unknown }).settings).toEqual(doc);
    expect(core.getAgentModels()).toEqual(doc);
  });

  it('PUT answers 400 for unsafe ids, unknown effort, bad reviewer lists, unknown workspace or key', async () => {
    const bad: unknown[] = [
      ...['a b', 'a"b', 'a&b', 'a|b', 'a%b', 'a^b', 'a\nb'].map(profile),
      { global: { stages: { description: { engine: 'claude', effort: 'ultra' } } }, workspaces: {} },
      { global: { reviewers: [1, 2, 3, 4, 5].map((n) => ({ engine: 'claude', model: `m${n}` })) }, workspaces: {} },
      { global: { reviewers: [{ engine: 'codex' }, { engine: 'codex' }] }, workspaces: {} },
      { global: {}, workspaces: { nope: { feedbackEval: { engine: 'codex' } } } },
      { global: { nope: 1 }, workspaces: {} },
      'not json',
    ];
    for (const b of bad) expect((await put(app, b)).status, JSON.stringify(b)).toBe(400);
    expect(core.getAgentModels()).toEqual({ global: {}, workspaces: {} });
  });

  it('a service token may read and report defaults, but never write the settings', async () => {
    const tokenApp = buildApp(core, { auth: { mode: 'token' } });
    const service = core.createApiToken({ label: 'reviewer', isService: true }).token;
    const auth = { authorization: `Bearer ${service}` };
    core.setAgentModels(profile('claude-opus-5-5'));

    const read = await tokenApp.request('/api/agent/agent-models', { headers: auth });
    expect(read.status).toBe(200);
    expect(await read.json()).toEqual(profile('claude-opus-5-5'));

    const report = await tokenApp.request('/api/agent/agent-models/defaults', {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ supervisor: 'reviewer', kind: 'reviewer', roles: { consensus: false } }),
    });
    expect(report.status).toBe(200);
    expect(core.getAgentModelDefaults()['reviewer']?.roles).toEqual({ consensus: false });

    expect((await put(tokenApp, { global: {}, workspaces: {} }, auth)).status).toBe(403);
    expect(core.getAgentModels()).toEqual(profile('claude-opus-5-5'));
  });
});
