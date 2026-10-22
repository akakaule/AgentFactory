import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

/** Per-workspace Azure DevOps work-item import: the board exposes the origin + a WIQL preview,
 *  and only lets the import be enabled on an Azure DevOps origin. */

const ORIGINS: Record<string, string> = {
  '/ado': 'https://dev.azure.com/kl/DIS/_git/dis',
  '/gh': 'https://github.com/akakaule/AgentFactory.git',
};
const patch = (app: ReturnType<typeof buildApp>, path: string, body: unknown) =>
  app.request(path, { method: 'PATCH', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
type WsView = { name: string; remote: { provider: string; organization?: string; project?: string } | null; adoSync: Record<string, unknown> | null; adoSyncWiql: string | null };
const list = async (app: ReturnType<typeof buildApp>) => (await (await app.request('/api/workspaces')).json()) as WsView[];

describe('workspaces — ADO work-item import', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let originCalls = 0;

  beforeEach(() => {
    core = openCore(':memory:');
    originCalls = 0;
    app = buildApp(core, { resolveOrigin: (p) => { originCalls++; return ORIGINS[p] ?? null; } });
    core.createWorkspace({ name: 'dis', repoPath: '/ado' });
    core.createWorkspace({ name: 'af', repoPath: '/gh' });
  });

  it('GET reports each workspace origin (provider + ADO org/project), null when unknown', async () => {
    const ws = await list(app);
    expect(ws.find((w) => w.name === 'dis')?.remote).toEqual({ provider: 'azdo', organization: 'kl', project: 'DIS' });
    expect(ws.find((w) => w.name === 'af')?.remote).toEqual({ provider: 'github' });
    expect(ws.find((w) => w.name === 'default')?.remote).toBeNull();
  });

  it('caches the origin lookup per repo path between requests', async () => {
    await list(app);
    const after = originCalls;
    await list(app);
    expect(originCalls).toBe(after);
  });

  it('PATCH stores the settings on an ADO workspace and GET previews the WIQL (@Me when assignTo is blank)', async () => {
    const res = await patch(app, '/api/workspaces/dis', { adoSync: { enabled: true, requiredTag: 'ai-agent', areaPath: 'DIS/Integration' } });
    expect(res.status).toBe(200);
    expect(((await res.json()) as WsView).adoSync).toMatchObject({ enabled: true, areaPath: 'DIS\\Integration' });
    const dis = (await list(app)).find((w) => w.name === 'dis')!;
    expect(dis.adoSyncWiql).toContain("[System.Tags] CONTAINS 'ai-agent'");
    expect(dis.adoSyncWiql).toContain('[System.AssignedTo] = @Me');
    expect((await list(app)).find((w) => w.name === 'af')?.adoSyncWiql).toBeNull();
  });

  it('PATCH refuses to enable the import on a non-ADO origin, but allows saving it disabled', async () => {
    const res = await patch(app, '/api/workspaces/af', { adoSync: { enabled: true } });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/Azure DevOps origin/);
    expect((await patch(app, '/api/workspaces/af', { adoSync: { enabled: false } })).status).toBe(200);
  });

  it('PATCH rejects invalid settings with 400', async () => {
    expect((await patch(app, '/api/workspaces/dis', { adoSync: { requiredTag: 'agentfactory' } })).status).toBe(400);
    expect((await patch(app, '/api/workspaces/dis', { adoSync: { states: [] } })).status).toBe(400);
  });
});
