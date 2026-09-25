import { describe, it, expect, beforeEach } from 'vitest';
import { openCore, buildFailureComment, type TaskDetail, type FailureTriageHistoryPage, type Activity } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const LOG = "src/a.ts(3,20): error TS2322: Type 'string' is not assignable to type 'number'.";
const crash = (tail: string) => buildFailureComment({
  reason: 'crashed', source: 'dispatcher', attempt: 1, maxAttempts: 3, detail: 'session `w` exited with code 1 with the task still in progress',
  body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail}\n\`\`\``,
});
const auth = (t: string | null): Record<string, string> => (t ? { authorization: `Bearer ${t}` } : {});
const post = (t: string | null, body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json', ...auth(t) }, body: JSON.stringify(body) });

function seed(core: ReturnType<typeof openCore>) {
  const task = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  const source = core.addComment(task.key, { actor: 'agent', body: crash(LOG) }).id;
  return { key: task.key, source };
}

describe('failure triage routes (token auth)', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  let human: string;
  let service: string;
  let userId: number;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core, { auth: { mode: 'token' } });
    userId = core.createUser({ email: 'op@example.com', displayName: 'Operator' }).id;
    human = core.createApiToken({ label: 'op', userId }).token;
    service = core.createApiToken({ label: 'worker', isService: true }).token;
  });

  it('exposes the derived label on task detail and list', async () => {
    const { key, source } = seed(core);
    const detail = await (await app.request(`/api/tasks/${key}`, { headers: auth(human) })).json() as TaskDetail;
    expect(detail.failureTriage).toMatchObject({ sourceActivityId: source, category: 'build_test', classifier: 'rules' });
    const list = await (await app.request('/api/tasks', { headers: auth(human) })).json() as TaskDetail[];
    expect(list[0]!.failureTriage).toMatchObject({ category: 'build_test' });
  });

  it('records feedback attributed to the principal, ignoring a forged actor', async () => {
    const { key, source } = seed(core);
    const res = await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(human, {
      sourceActivityId: source, action: 'correct', category: 'configuration', shownCategory: 'build_test', note: 'missing SDK', actorUserId: 999,
    }));
    expect(res.status).toBe(200);
    const detail = await res.json() as TaskDetail;
    expect(detail.failureTriage).toMatchObject({ classifier: 'human', category: 'configuration', human: { actorUserId: userId, actorName: 'Operator', note: 'missing SDK' } });
  });

  it('rejects service principals on every human triage route', async () => {
    const { key, source } = seed(core);
    expect((await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(service, { sourceActivityId: source, action: 'confirm', shownCategory: 'build_test' }))).status).toBe(403);
    expect((await app.request(`/api/tasks/${key}/failure-triage/history`, { headers: auth(service) })).status).toBe(403);
    expect((await app.request(`/api/tasks/${key}/failure-triage/source/${source}`, { headers: auth(service) })).status).toBe(403);
    expect((await app.request(`/api/tasks/${key}/failure-triage/history`)).status).toBe(401);
  });

  it('maps stale labels, bad bodies, and foreign sources to 409 / 400 / 404', async () => {
    const { key, source } = seed(core);
    const other = seed(core);
    expect((await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(human, { sourceActivityId: source, action: 'confirm', shownCategory: 'access' }))).status).toBe(409);
    expect((await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(human, { sourceActivityId: source, action: 'maybe', shownCategory: 'build_test' }))).status).toBe(400);
    expect((await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(human, { sourceActivityId: other.source, action: 'confirm', shownCategory: 'build_test' }))).status).toBe(404);
    expect((await app.request(`/api/tasks/${key}/failure-triage/source/${other.source}`, { headers: auth(human) })).status).toBe(404);
    expect((await app.request(`/api/tasks/${key}/failure-triage/source/abc`, { headers: auth(human) })).status).toBe(400);
    expect((await app.request(`/api/tasks/${key}/failure-triage/history?limit=0`, { headers: auth(human) })).status).toBe(400);
  });

  it('serves history pages and the exact source note', async () => {
    const { key, source } = seed(core);
    const second = core.addComment(key, { actor: 'agent', body: crash('fatal: Authentication failed') }).id;
    const page = await (await app.request(`/api/tasks/${key}/failure-triage/history?limit=1`, { headers: auth(human) })).json() as FailureTriageHistoryPage;
    expect(page.items.map((i) => i.sourceActivityId)).toEqual([second]);
    expect(page.nextBeforeId).toBe(second);
    const older = await (await app.request(`/api/tasks/${key}/failure-triage/history?limit=1&beforeId=${page.nextBeforeId}`, { headers: auth(human) })).json() as FailureTriageHistoryPage;
    expect(older.items).toMatchObject([{ sourceActivityId: source, rules: { category: 'build_test' } }]);
    const note = await (await app.request(`/api/tasks/${key}/failure-triage/source/${source}`, { headers: auth(human) })).json() as Activity;
    expect(note.body).toContain('error TS2322');
  });
});

describe('failure triage routes (auth none: single operator)', () => {
  it('accepts feedback without a token', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const { key, source } = seed(core);
    const res = await app.request(`/api/tasks/${key}/failure-triage/feedback`, post(null, { sourceActivityId: source, action: 'confirm', shownCategory: 'build_test' }));
    expect(res.status).toBe(200);
    expect((await res.json() as TaskDetail).failureTriage).toMatchObject({ classifier: 'human', human: { action: 'confirm', actorUserId: null } });
  });
});
