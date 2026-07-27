import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

/** #45 agent-ops surface: service-token-only routes with the actor derived server-side. */

type App = ReturnType<typeof buildApp>;
type Core = ReturnType<typeof openCore>;

const post = (app: App, path: string, body: unknown, token?: string) =>
  app.request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  });
const get = (app: App, path: string, token?: string) =>
  app.request(path, { headers: token ? { authorization: `Bearer ${token}` } : {} });

function queuedTask(core: Core, title = 'Agent work') {
  const t = core.createTask({ title, spec: 'S', acceptanceCriteria: 'A' });
  core.updateStatus(t.key, 'queued', 'human');
  return t;
}

describe('agent ops — authorization boundary', () => {
  let core: Core;
  let app: App;
  let service: string;
  let supervisor: string;
  let user: string;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core, { auth: { mode: 'token' } });
    service = core.createApiToken({ label: 'worker-1', isService: true }).token;
    supervisor = core.createApiToken({ label: 'dispatcher-1', isService: true, isSupervisor: true }).token;
    const u = core.createUser({ email: 'ann@example.com', displayName: 'Ann' });
    user = core.createApiToken({ label: 'ann-cli', userId: u.id }).token;
  });

  it('a token that is neither a user nor a declared service token is rejected outright', async () => {
    const malformed = core.createApiToken({ label: 'oops', isService: false }).token; // no user, no flag
    expect((await post(app, '/api/agent/claim', {}, malformed)).status).toBe(401);
    expect((await app.request('/api/tasks', { headers: { authorization: `Bearer ${malformed}` } })).status).toBe(401);
  });

  it('supervisor-only ops reject a plain worker service token', async () => {
    const t = queuedTask(core);
    core.claimNextTask({ claimedBy: 'w1' });

    expect((await post(app, `/api/agent/tasks/${t.key}/release-claim`, {}, service)).status).toBe(403);
    expect((await post(app, `/api/agent/tasks/${t.key}/delivery/complete`, { note: 'x' }, service)).status).toBe(403);
    expect((await get(app, '/api/agent/workspaces/default/pat', service)).status).toBe(403);
    // the supervisor token passes the guard
    expect((await post(app, `/api/agent/tasks/${t.key}/release-claim`, {}, supervisor)).status).toBe(200);
  });

  it('agent routes require a service token: user → 403, missing → 401, service → 200', async () => {
    queuedTask(core);
    expect((await post(app, '/api/agent/claim', {}, user)).status).toBe(403);
    expect((await post(app, '/api/agent/claim', {})).status).toBe(401);
    const res = await post(app, '/api/agent/claim', {}, service);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe('in_progress');
  });

  it('anon (AUTH_MODE=none) is rejected on agent routes — local MCP keeps the direct DB path', async () => {
    const anonApp = buildApp(core);
    expect((await post(anonApp, '/api/agent/claim', {})).status).toBe(403);
  });

  it('human lifecycle routes reject service tokens (an agent can never approve)', async () => {
    const t = queuedTask(core);
    core.claimNextTask({ claimedBy: 'w1' });
    core.submitResult(t.key, { summary: 'done' });

    expect((await post(app, `/api/tasks/${t.key}/approve`, {}, service)).status).toBe(403);
    expect((await post(app, `/api/tasks/${t.key}/status`, { status: 'done' }, service)).status).toBe(403);
    // the human token still works
    expect((await post(app, `/api/tasks/${t.key}/approve`, {}, user)).status).toBe(200);
  });

  it('comments through the agent surface are forced to actor agent', async () => {
    const t = queuedTask(core);
    const res = await post(app, `/api/agent/tasks/${t.key}/comments`, { body: 'hello from a worker' }, service);
    expect(res.status).toBe(201);
    const detail = core.getTask(t.key);
    const comment = detail.activity.filter((a) => a.type === 'comment').at(-1)!;
    expect(comment.actor).toBe('agent');
  });

  it('status through the agent surface runs as agent — human-only edges are refused', async () => {
    const t = queuedTask(core);
    core.claimNextTask({ claimedBy: 'w1' });

    const blocked = await post(app, `/api/agent/tasks/${t.key}/status`, { status: 'blocked', note: 'need creds' }, service);
    expect(blocked.status).toBe(200);
    // in_review → done is a human edge; asserting it as a service caller must fail (409, not honored)
    core.updateStatus(t.key, 'in_progress', 'agent');
    core.submitResult(t.key, { summary: 'done' });
    expect((await post(app, `/api/agent/tasks/${t.key}/status`, { status: 'done' }, service)).status).toBe(409);
  });
});

describe('agent ops — the worked loop over HTTP', () => {
  let core: Core;
  let app: App;
  let service: string;
  let supervisor: string;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core, { auth: { mode: 'token' } });
    service = core.createApiToken({ label: 'worker-1', isService: true }).token;
    supervisor = core.createApiToken({ label: 'dispatcher-1', isService: true, isSupervisor: true }).token;
  });

  it('claim → progress → submit lands the task in review with a live-session trail', async () => {
    const t = queuedTask(core);

    const claim = await post(app, '/api/agent/claim', { claimedBy: 'remote-w1' }, service);
    const claimed = (await claim.json()) as { key: string; branchCreated: boolean };
    expect(claimed.key).toBe(t.key);

    expect((await post(app, `/api/agent/tasks/${t.key}/progress`, { message: 'scaffolding', tokensIn: 10 }, service)).status).toBe(200);
    expect(core.listLiveAgents()[0]?.phase).toBe('scaffolding');

    const submit = await post(app, `/api/agent/tasks/${t.key}/submit`, { summary: 'did it', links: [] }, service);
    expect(submit.status).toBe(200);
    expect(((await submit.json()) as { status: string }).status).toBe('in_review');
  });

  it('an empty queue claims null (idle signal, not an error)', async () => {
    const res = await post(app, '/api/agent/claim', {}, service);
    expect(res.status).toBe(200);
    expect(await res.json()).toBeNull();
  });

  it('release-claim performs the system recovery edge', async () => {
    const t = queuedTask(core);
    core.claimNextTask({ claimedBy: 'w1' });

    const res = await post(app, `/api/agent/tasks/${t.key}/release-claim`, {}, supervisor);
    expect(res.status).toBe(200);
    const detail = core.getTask(t.key);
    expect(detail.status).toBe('queued');
    expect(detail.activity.filter((a) => a.type === 'status_change').at(-1)!.body).toContain('system-reap');
  });

  it('creating a task through the agent surface lands in backlog with actor agent', async () => {
    const res = await post(app, '/api/agent/tasks', { title: 'Found a bug', spec: 'S', acceptanceCriteria: 'A' }, service);
    expect(res.status).toBe(201);
    const created = (await res.json()) as { key: string; status: string };
    expect(created.status).toBe('backlog');
  });

  it('serves git-auth and workspace PAT to service tokens only', async () => {
    core.createWorkspace({ name: 'shop', repoPath: '/repo' });
    core.updateWorkspace('shop', { pat: 'sekret-pat' });

    const auth = await get(app, '/api/agent/workspaces/shop/git-auth', service);
    expect(auth.status).toBe(200); // GitAuth | null — null is fine when no origin resolves

    const pat = await get(app, '/api/agent/workspaces/shop/pat', supervisor);
    expect(((await pat.json()) as { pat: string | null }).pat).toBe('sekret-pat');

    expect((await get(app, '/api/agent/workspaces/shop/pat')).status).toBe(401);
  });

  it('heartbeat + prompts + live-agents round-trip', async () => {
    expect((await post(app, '/api/agent/supervisors/heartbeat', {
      name: 'remote-1', kind: 'dispatcher', workspaces: ['default'], inFlight: 0, capacity: 1, pollSeconds: 15,
    }, service)).status).toBe(200);

    const prompt = await get(app, '/api/agent/prompts/worker?workspace=default', service);
    expect(prompt.status).toBe(200);
    expect((await prompt.json()) as { prompt: string }).toHaveProperty('prompt');

    expect((await get(app, '/api/agent/live-agents', service)).status).toBe(200);
  });

  it('a malformed JSON body is a 400 with a message, not a 500', async () => {
    const res = await app.request('/api/agent/claim', {
      method: 'POST', body: 'not json', headers: { 'content-type': 'application/json', authorization: `Bearer ${service}` },
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { message: string }).message).toMatch(/JSON body/);
  });
});
