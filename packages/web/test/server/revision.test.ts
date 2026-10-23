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
