import { describe, it, expect, beforeEach } from 'vitest';
import { openCore, createHttpCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

/** AF-202: a delegate token acts on the human routes as its user, never on the agent surface,
 *  and every activity row it writes carries the token label next to the user. */

type Core = ReturnType<typeof openCore>;
type ActivityJson = { id: number; type: string; actor: string; toStatus: string | null; actorUserId: number | null; actorName: string | null; actorDelegate: string | null };

const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } });
const postJson = (t: string, body: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${t}` },
  body: JSON.stringify(body),
});

describe('delegate tokens over HTTP', () => {
  let core: Core;
  let app: ReturnType<typeof buildApp>;
  let userId: number;
  let delegate: string;
  let plain: string;
  let service: string;
  let supervisor: string;

  /** A task walked the legal way to in_review, with its current submission id. */
  function inReview(title = 'T'): { key: string; submissionId: number } {
    const t = core.createTask({ title, spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ taskKey: t.key });
    core.submitResult(t.key, { summary: 'done' });
    return { key: t.key, submissionId: core.getTask(t.key).submission!.id };
  }
  const rows = (key: string) => core.getTask(key).activity;
  const newestRaw = (key: string) => core.getTask(key).activity.at(-1)!;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core, { auth: { mode: 'token' } });
    userId = core.createUser({ email: 'alvin@example.com', displayName: 'Alvin' }).id;
    delegate = core.createApiToken({ label: 'Claude Code', userId, delegate: true }).token;
    plain = core.createApiToken({ label: 'phone', userId }).token;
    service = core.createApiToken({ label: 'bridge', isService: true }).token;
    supervisor = core.createApiToken({ label: 'dispatcher', isService: true, isSupervisor: true }).token;
  });

  it('whoami reports a user principal carrying the delegate label', async () => {
    expect(await (await app.request('/auth/whoami', bearer(delegate))).json())
      .toEqual({ kind: 'user', userId, email: 'alvin@example.com', displayName: 'Alvin', delegate: 'Claude Code' });
    expect(await (await app.request('/auth/whoami', bearer(plain))).json()).toMatchObject({ kind: 'user', delegate: null });
  });

  it('passes approve, request-changes and a cancel status move; a service token gets 403 (AC3)', async () => {
    const a = inReview('approve');
    expect((await app.request(`/api/tasks/${a.key}/approve`, postJson(service, { submissionId: a.submissionId }))).status).toBe(403);
    expect((await app.request(`/api/tasks/${a.key}/approve`, postJson(delegate, { submissionId: a.submissionId }))).status).toBe(200);

    const b = inReview('changes');
    expect((await app.request(`/api/tasks/${b.key}/request-changes`, postJson(service, { feedback: 'fix' }))).status).toBe(403);
    expect((await app.request(`/api/tasks/${b.key}/request-changes`, postJson(delegate, { feedback: 'fix' }))).status).toBe(200);

    const c = core.createTask({ title: 'cancel', spec: 'S', acceptanceCriteria: 'A' });
    expect((await app.request(`/api/tasks/${c.key}/status`, postJson(service, { status: 'cancelled' }))).status).toBe(403);
    expect((await app.request(`/api/tasks/${c.key}/status`, postJson(delegate, { status: 'cancelled' }))).status).toBe(200);
    expect(newestRaw(c.key)).toMatchObject({ toStatus: 'cancelled', actorUserId: userId, actorDelegate: 'Claude Code' });
  });

  it('is refused on the agent surface, including supervisor-only routes (AC4)', async () => {
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    expect((await app.request('/api/agent/claim', postJson(delegate, {}))).status).toBe(403);
    core.claimNextTask({ taskKey: t.key });
    expect((await app.request(`/api/agent/tasks/${t.key}/release-claim`, postJson(delegate, {}))).status).toBe(403);
    expect((await app.request(`/api/agent/tasks/${t.key}/release-claim`, postJson(supervisor, {}))).status).toBe(200);
  });

  it('attributes a delegate approve to user + label; plain user and service rows stay null (AC5)', async () => {
    const a = inReview('delegate');
    await app.request(`/api/tasks/${a.key}/approve`, postJson(delegate, { submissionId: a.submissionId }));
    expect(newestRaw(a.key)).toMatchObject({ actor: 'human', actorUserId: userId, actorDelegate: 'Claude Code' });

    const b = inReview('plain');
    await app.request(`/api/tasks/${b.key}/approve`, postJson(plain, { submissionId: b.submissionId }));
    expect(newestRaw(b.key)).toMatchObject({ actor: 'human', actorUserId: userId, actorDelegate: null });

    expect((await app.request(`/api/tasks/${b.key}/comment`, postJson(service, { body: 'from the bridge' }))).status).toBe(201);
    expect(newestRaw(b.key)).toMatchObject({ actor: 'agent', body: 'from the bridge', actorDelegate: null });
  });

  it('stamps both rows a delegate request-changes writes (AC6)', async () => {
    const t = inReview();
    const before = rows(t.key).at(-1)!.id;
    await app.request(`/api/tasks/${t.key}/request-changes`, postJson(delegate, { feedback: 'fix it' }));
    const written = rows(t.key).filter((a) => a.id > before);
    expect(written.map((a) => a.type).sort()).toEqual(['feedback', 'status_change']);
    for (const a of written) expect(a.actorDelegate).toBe('Claude Code');
  });

  it('threads the delegate through the other human write routes', async () => {
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect((await app.request(`/api/tasks/${t.key}/comment`, postJson(delegate, { body: 'note' }))).status).toBe(201);
    expect(newestRaw(t.key)).toMatchObject({ type: 'comment', actor: 'human', actorDelegate: 'Claude Code' });
    expect((await app.request(`/api/tasks/${t.key}/status`, postJson(delegate, { status: 'queued' }))).status).toBe(200);
    expect(newestRaw(t.key)).toMatchObject({ toStatus: 'queued', actorDelegate: 'Claude Code' });
  });

  it('serves actorDelegate on GET /api/tasks/:key and keeps it through httpCore (AC7)', async () => {
    const a = inReview('delegate');
    await app.request(`/api/tasks/${a.key}/approve`, postJson(delegate, { submissionId: a.submissionId }));
    const b = inReview('plain');
    await app.request(`/api/tasks/${b.key}/approve`, postJson(plain, { submissionId: b.submissionId }));

    const done = (acts: ActivityJson[]) => acts.find((x) => x.type === 'status_change' && x.toStatus === 'done')!;
    const ja = await (await app.request(`/api/tasks/${a.key}`, bearer(plain))).json() as { activity: ActivityJson[] };
    const jb = await (await app.request(`/api/tasks/${b.key}`, bearer(plain))).json() as { activity: ActivityJson[] };
    expect(done(ja.activity)).toMatchObject({ actorName: 'Alvin', actorDelegate: 'Claude Code' });
    expect(done(jb.activity).actorDelegate).toBeNull();

    const http = createHttpCore('http://board', service, {
      fetchImpl: ((url: string | URL | Request, init?: RequestInit) => app.request(url as string, init)) as typeof fetch,
    });
    const viaHttp = await http.getTask(a.key);
    expect(done(viaHttp.activity as ActivityJson[]).actorDelegate).toBe('Claude Code');
    expect(done((await http.getTask(b.key)).activity as ActivityJson[]).actorDelegate).toBeNull();
  });
});
