/**
 * Revision-bound review over HTTP (AF-148): the approve route refreshes the branch head through the
 * git adapter and approves only the submission/revision the human looked at; the diff route can
 * reproduce the submitted snapshot after the branch moved on and the worktree is gone.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { openCore, type RemoteHead } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';
import { initGitRepo, addBranchWithChange, commitFile, gitIn, cleanupRepo } from './helpers/gitFixtures.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

const post = (app: ReturnType<typeof buildApp>, path: string, body: unknown = {}) =>
  app.request(path, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });

function boardWith(head: () => RemoteHead) {
  const core = openCore(':memory:', { resolveOrigin: () => null, resolveRemoteHead: async () => head() });
  const app = buildApp(core);
  return { core, app };
}

function submitted(core: ReturnType<typeof openCore>, headSha: string, workspace?: string) {
  const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation', ...(workspace ? { workspace } : {}) });
  core.updateStatus(t.key, 'queued', 'human');
  const claim = core.claimNextTask({ claimedBy: 'w' })!;
  const detail = core.submitResult(t.key, { summary: 'r1', revision: { headSha, source: 'origin' }, links: [{ kind: 'branch', label: claim.branch!, url: 'http://x/b' }] });
  return { key: t.key, submissionId: detail.submission!.id };
}

describe('approve names the reviewed revision', () => {
  it('approves the current submission once the git refresh still sees its head', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    const res = await post(app, `/api/tasks/${key}/approve`, { submissionId, headSha: A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'done' });
  });

  it('refuses (409) when the refresh sees a newer push — the old green review is not inherited', async () => {
    const { core, app } = boardWith(() => ({ headSha: B, error: null }));
    const { key, submissionId } = submitted(core, A);
    const res = await post(app, `/api/tasks/${key}/approve`, { submissionId, headSha: A });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { message: string }).message).toMatch(/changed since/);
    expect(core.getTask(key)).toMatchObject({ status: 'in_review', submission: { freshness: 'stale' } });
  });

  it('refuses (409) an approval naming a superseded submission', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    const res = await post(app, `/api/tasks/${key}/approve`, { submissionId: submissionId + 1, headSha: A });
    expect(res.status).toBe(409);
  });

  it('shows unknown freshness when the origin is unreachable and audits the approval', async () => {
    const { core, app } = boardWith(() => ({ headSha: null, error: 'origin unreachable' }));
    const { key, submissionId } = submitted(core, A);
    const res = await post(app, `/api/tasks/${key}/approve`, { submissionId, headSha: A });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { activity: Array<{ body: string }> };
    expect(body.activity.some((a) => /unknown revision freshness/.test(a.body))).toBe(true);
  });

  it('rejects a malformed expected head (400)', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    expect((await post(app, `/api/tasks/${key}/approve`, { submissionId, headSha: 'HEAD' })).status).toBe(400);
  });
});

describe('a raw status close refreshes the revision like approve', () => {
  it('refuses (409) a raw in_review → done/delivering move once the refresh sees a newer push', async () => {
    let reads = 0;
    const { core, app } = boardWith(() => { reads++; return { headSha: B, error: null }; });
    const { key } = submitted(core, A);
    for (const status of ['done', 'delivering']) {
      const res = await post(app, `/api/tasks/${key}/status`, { status });
      expect(res.status).toBe(409);
      expect(((await res.json()) as { message: string }).message).toMatch(/changed since/);
    }
    expect(reads).toBeGreaterThan(0);
    expect(core.getTask(key)).toMatchObject({ status: 'in_review', submission: { freshness: 'stale' } });
  });

  it('closes a current implementation and audits an unreachable origin as unknown freshness', async () => {
    const { core, app } = boardWith(() => ({ headSha: null, error: 'origin unreachable' }));
    const { key, submissionId } = submitted(core, A);
    // a close that names no submission is refused while one is tracked (it could approve a replacement unseen)
    expect((await post(app, `/api/tasks/${key}/status`, { status: 'done' })).status).toBe(409);
    const res = await post(app, `/api/tasks/${key}/status`, { status: 'done', submissionId });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; activity: Array<{ type: string; body: string }> };
    expect(body.status).toBe('done');
    expect(body.activity.some((a) => a.type === 'comment' && /unknown revision freshness/.test(a.body) && a.body.includes('origin unreachable'))).toBe(true);
  });

  it('a raw close names the reviewed submission: a superseded one or another head is refused (409), the current one closes', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    const stale = await post(app, `/api/tasks/${key}/status`, { status: 'delivering', submissionId: submissionId + 1, headSha: A });
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { message: string }).message).toMatch(/approval names submission/);
    expect((await post(app, `/api/tasks/${key}/status`, { status: 'done', submissionId, headSha: B })).status).toBe(409);
    expect(core.getTask(key).status).toBe('in_review');
    const res = await post(app, `/api/tasks/${key}/status`, { status: 'done', submissionId, headSha: A });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'done' });
  });

  it('rejects a malformed expected head on a raw close (400)', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    expect((await post(app, `/api/tasks/${key}/status`, { status: 'done', submissionId, headSha: 'HEAD' })).status).toBe(400);
  });

  it('does not touch git for status moves that do not close a review', async () => {
    let reads = 0;
    const { core, app } = boardWith(() => { reads++; return { headSha: A, error: null }; });
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    expect((await post(app, `/api/tasks/${t.key}/status`, { status: 'queued' })).status).toBe(200);
    expect(reads).toBe(0);
  });
});

describe('diff of the submitted revision', () => {
  let repo: string | undefined;
  afterEach(() => { if (repo) cleanupRepo(repo); repo = undefined; });

  it('?at=submission reproduces the submitted snapshot after the branch moved', { timeout: 30000 }, async () => {
    repo = initGitRepo();
    const { core, app } = boardWith(() => ({ headSha: null, error: 'n/a' }));
    core.createWorkspace({ name: 'repo', repoPath: repo });
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation', workspace: 'repo' });
    core.updateStatus(t.key, 'queued', 'human');
    const claim = core.claimNextTask({ workspace: 'repo', claimedBy: 'w' })!;
    const branch = claim.branch!;
    const base = gitIn(repo, 'rev-parse', 'main').trim();
    addBranchWithChange(repo, branch, 'feature.txt', 'reviewed\n');
    const head = gitIn(repo, 'rev-parse', branch).trim();
    core.submitResult(t.key, { summary: 'r1', revision: { headSha: head, baseSha: base, source: 'origin' }, links: [{ kind: 'branch', label: branch, url: 'http://x/b' }] });
    // a later push on the same branch
    gitIn(repo, 'switch', branch);
    commitFile(repo, 'feature.txt', 'pushed after review\n');
    gitIn(repo, 'switch', 'main');

    const live = (await (await app.request(`/api/tasks/${t.key}/diff`)).json()) as { diff: string; headSha: string };
    expect(live.diff).toContain('+pushed after review');
    expect(live.headSha).not.toBe(head);

    const res = await app.request(`/api/tasks/${t.key}/diff?at=submission`);
    expect(res.status).toBe(200);
    const snap = (await res.json()) as { diff: string; headSha: string; baseSha: string; submissionId: number };
    expect(snap).toMatchObject({ headSha: head, baseSha: base });
    expect(snap.diff).toContain('+reviewed');
    expect(snap.diff).not.toContain('pushed after review');
  });

  it('?at=submission is a 404 when the submission recorded no revision (historical task)', async () => {
    const { core, app } = boardWith(() => ({ headSha: null, error: 'n/a' }));
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
    core.updateStatus(t.key, 'queued', 'human');
    const claim = core.claimNextTask({ claimedBy: 'w' })!;
    core.submitResult(t.key, { summary: 'r1', links: [{ kind: 'branch', label: claim.branch!, url: 'http://x/b' }] });
    expect((await app.request(`/api/tasks/${t.key}/diff?at=submission`)).status).toBe(404);
  });
});

describe('visualization upload names the revision it depicts', () => {
  const upload = (app: ReturnType<typeof buildApp>, key: string, headers: Record<string, string>) =>
    app.request(`/api/tasks/${key}/visualization`, { method: 'POST', body: '<html>viz</html>', headers: { 'content-type': 'text/html', ...headers } });

  it('stamps the uploaded head and rejects malformed revision headers', async () => {
    const { core, app } = boardWith(() => ({ headSha: A, error: null }));
    const { key, submissionId } = submitted(core, A);
    expect((await upload(app, key, { 'x-agentfactory-submission-id': String(submissionId), 'x-agentfactory-head-sha': 'HEAD' })).status).toBe(400);
    expect((await upload(app, key, { 'x-agentfactory-submission-id': 'one' })).status).toBe(400);
    expect((await upload(app, key, { 'x-agentfactory-head-sha': B })).status).toBe(400);
    expect((await upload(app, key, { 'x-agentfactory-submission-id': String(submissionId), 'x-agentfactory-head-sha': B })).status).toBe(201);
    expect(core.getTask(key).visualizationRevision).toEqual({ submissionId, headSha: B });
  });
});
