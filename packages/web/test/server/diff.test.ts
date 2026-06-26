import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';
import { initGitRepo, addBranchWithChange, cleanupRepo } from './helpers/gitFixtures.js';

describe('GET /api/tasks/:key/diff', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;
  const dirs: string[] = [];
  const track = (dir: string) => { dirs.push(dir); return dir; };

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });
  afterEach(() => { while (dirs.length) cleanupRepo(dirs.pop()!); });

  /** Task in the given workspace, driven to in_review with the given links. */
  const submittedTask = (workspace: string, links: { kind: 'branch' | 'pr'; label: string; url: string }[]) => {
    const task = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace });
    core.updateStatus(task.key, 'queued', 'human');
    core.claimNextTask({ workspace });
    core.submitResult(task.key, { summary: 'done', links });
    return task;
  };

  it('returns branch, baseRef and the merge-base diff', async () => {
    const dir = track(initGitRepo());
    addBranchWithChange(dir, 'task/AF-1', 'feature.txt', 'agent work\n');
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [{ kind: 'branch', label: 'task/AF-1', url: 'http://example.com/b' }]);

    const res = await app.request(`/api/tasks/${task.key}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json() as { branch: string; baseRef: string; diff: string; commits: number };
    expect(body.branch).toBe('task/AF-1');
    expect(body.baseRef).toBe('main');
    expect(body.diff).toContain('+agent work');
    expect(body.commits).toBe(1);
  });

  it('uses the last branch link when several were submitted', async () => {
    const dir = track(initGitRepo());
    addBranchWithChange(dir, 'task/AF-1', 'first.txt', 'first attempt\n');
    addBranchWithChange(dir, 'task/AF-1-v2', 'second.txt', 'second attempt\n');
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [
      { kind: 'branch', label: 'task/AF-1', url: 'http://example.com/b1' },
      { kind: 'branch', label: 'task/AF-1-v2', url: 'http://example.com/b2' },
    ]);

    const body = await (await app.request(`/api/tasks/${task.key}/diff`)).json() as { branch: string; diff: string };
    expect(body.branch).toBe('task/AF-1-v2');
    expect(body.diff).toContain('second.txt');
    expect(body.diff).not.toContain('first.txt');
  });

  it('decorated branch label (annotation suffix) resolves the diff against the bare ref', async () => {
    const dir = track(initGitRepo());
    addBranchWithChange(dir, 'task/AF-1', 'feature.txt', 'agent work\n');
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const label = 'task/AF-1 (PR 4703 source — conflict fix pushed here)';
    const task = submittedTask('fix', [{ kind: 'branch', label, url: 'http://example.com/b' }]);

    const res = await app.request(`/api/tasks/${task.key}/diff`);
    expect(res.status).toBe(200);
    const body = await res.json() as { branch: string; diff: string };
    expect(body.branch).toBe(label);            // the UI still shows the full decorated label
    expect(body.diff).toContain('+agent work'); // …but the diff resolved against the clean ref
  });

  it('unknown task → 404 JSON', async () => {
    const res = await app.request('/api/tasks/AF-9999/diff');
    expect(res.status).toBe(404);
    expect((await res.json() as { message: string }).message).toMatch(/AF-9999/);
  });

  it('task without a branch link → 404 JSON', async () => {
    const dir = track(initGitRepo());
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [{ kind: 'pr', label: 'PR #1', url: 'http://example.com/pr/1' }]);

    const res = await app.request(`/api/tasks/${task.key}/diff`);
    expect(res.status).toBe(404);
    expect((await res.json() as { message: string }).message).toMatch(/branch link/);
  });

  it('branch link whose branch is gone → 404', async () => {
    const dir = track(initGitRepo());
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [{ kind: 'branch', label: 'task/AF-gone', url: 'http://example.com/b' }]);

    expect((await app.request(`/api/tasks/${task.key}/diff`)).status).toBe(404);
  });

  it('workspace repoPath that is not a git repo → 422', async () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'af-norepo-')));
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [{ kind: 'branch', label: 'task/AF-1', url: 'http://example.com/b' }]);

    const res = await app.request(`/api/tasks/${task.key}/diff`);
    expect(res.status).toBe(422);
    expect((await res.json() as { message: string }).message).toMatch(/not a git repository/);
  });

  it('hostile branch label → 400, never reaches git', async () => {
    const dir = track(initGitRepo());
    core.createWorkspace({ name: 'fix', repoPath: dir });
    const task = submittedTask('fix', [{ kind: 'branch', label: '--output=evil', url: 'http://example.com/b' }]);

    expect((await app.request(`/api/tasks/${task.key}/diff`)).status).toBe(400);
  });
});
