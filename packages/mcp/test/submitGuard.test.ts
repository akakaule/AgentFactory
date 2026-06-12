import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkSubmission } from '../src/git.js';
import { makeClient, textOf } from './harness.js';

const BRANCH = 'feature/AF-1-test';
const KEY = 'AF-1';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const temps: string[] = [];
function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

/** A repo with one commit on main and a `${BRANCH}` branch checked out. */
function initRepo(): string {
  const dir = mkTemp('af-guard-');
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  git(dir, 'checkout', '-b', BRANCH);
  git(dir, 'commit', '--allow-empty', '-m', 'work');
  return dir;
}

/** Add a bare origin and return its path. */
function addOrigin(repo: string): string {
  const bare = mkTemp('af-origin-');
  git(bare, 'init', '--bare', '-b', 'main');
  git(repo, 'remote', 'add', 'origin', bare);
  return bare;
}

beforeEach(() => { temps.length = 0; });
afterEach(() => {
  for (const d of temps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* worktree locks on Windows — best effort */ }
  }
});

describe('checkSubmission — passing states', () => {
  it('accepts a fully-pushed branch with no surviving worktree', async () => {
    const repo = initRepo();
    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', BRANCH);
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(true);
  });
});

describe('checkSubmission — rejecting states', () => {
  it('rejects a branch missing on origin with a push command', async () => {
    const repo = initRepo();
    addOrigin(repo); // branch never pushed
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(`git push -u origin ${BRANCH}`);
  });

  it('rejects when origin is behind local (not fully pushed)', async () => {
    const repo = initRepo();
    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', BRANCH);
    git(repo, 'commit', '--allow-empty', '-m', 'newer, unpushed'); // local ahead of origin
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(false);
    expect(res.message).toContain(`git push origin ${BRANCH}`);
  });

  it('rejects a surviving .worktrees/<key> with a remove command', async () => {
    const repo = initRepo();
    addOrigin(repo);
    git(repo, 'push', '-u', 'origin', BRANCH);
    // a worktree the worker forgot to remove
    git(repo, 'worktree', 'add', join(repo, '.worktrees', KEY), '-b', 'feature/AF-1-leftover');
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('git worktree remove');
    expect(res.message).toContain(`.worktrees/${KEY}`);
  });
});

describe('checkSubmission — origin variants', () => {
  it('with no origin remote: enforces the worktree check, skips push checks', async () => {
    const repo = initRepo(); // no origin at all
    // clean (no worktree) → accepted even though nothing is pushed
    expect((await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY })).ok).toBe(true);

    // but a surviving worktree is still caught
    git(repo, 'worktree', 'add', join(repo, '.worktrees', KEY), '-b', 'feature/AF-1-leftover');
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(false);
    expect(res.message).toContain('git worktree remove');
  });

  it('fails closed when origin is configured but unreachable', async () => {
    const repo = initRepo();
    git(repo, 'remote', 'add', 'origin', join(tmpdir(), 'af-does-not-exist-xyz.git'));
    const res = await checkSubmission({ repoPath: repo, branch: BRANCH, key: KEY });
    expect(res.ok).toBe(false);
    expect(res.message?.toLowerCase()).toContain('unreachable');
  });
});

describe('checkSubmission — degradation (skips, never blocks)', () => {
  it('skips a null branch (legacy claim)', async () => {
    const repo = initRepo();
    expect((await checkSubmission({ repoPath: repo, branch: null, key: KEY })).ok).toBe(true);
  });

  it('skips a relative repoPath', async () => {
    expect((await checkSubmission({ repoPath: '.', branch: BRANCH, key: KEY })).ok).toBe(true);
  });

  it('skips a missing repoPath', async () => {
    const missing = join(tmpdir(), 'af-absent-dir-zzz');
    expect((await checkSubmission({ repoPath: missing, branch: BRANCH, key: KEY })).ok).toBe(true);
  });

  it('skips a directory that is not a git repository', async () => {
    const dir = mkTemp('af-nongit-');
    expect((await checkSubmission({ repoPath: dir, branch: BRANCH, key: KEY })).ok).toBe(true);
  });
});

describe('submit_result tool — guardrail wiring (integration)', () => {
  /** Repo with main + a reachable bare origin, but no feature branch yet. */
  function mainOnlyRepoWithOrigin(): string {
    const dir = mkTemp('af-int-');
    git(dir, 'init', '-b', 'main');
    git(dir, 'config', 'user.email', 'test@example.com');
    git(dir, 'config', 'user.name', 'Test');
    git(dir, 'commit', '--allow-empty', '-m', 'init');
    addOrigin(dir);
    return dir;
  }

  it('blocks submit until the branch is pushed, then accepts; task stays in_progress while blocked', async () => {
    const repo = mainOnlyRepoWithOrigin();
    const { client, core } = await makeClient();
    core.createWorkspace({ name: 'wt', repoPath: repo });
    const t = core.createTask({ title: 'Wire it up', spec: 's', acceptanceCriteria: 'a', workspace: 'wt' });
    core.updateStatus(t.key, 'queued', 'human');

    const claimed = JSON.parse(textOf(await client.callTool({ name: 'get_next_task', arguments: { workspace: 'wt' } })));
    const branch: string = claimed.protocol.branch;

    // nothing pushed → blocked, task unchanged
    const blocked = await client.callTool({ name: 'submit_result', arguments: { key: t.key, summary: 'done', links: [] } });
    expect(blocked.isError).toBe(true);
    expect(textOf(blocked)).toContain(`git push -u origin ${branch}`);
    expect(core.getTask(t.key).status).toBe('in_progress');

    // push the server-named branch → accepted, task advances
    git(repo, 'branch', branch);
    git(repo, 'push', '-u', 'origin', branch);
    const ok = await client.callTool({ name: 'submit_result', arguments: { key: t.key, summary: 'done', links: [] } });
    expect(ok.isError).toBeFalsy();
    expect(core.getTask(t.key).status).toBe('in_review');
  });
});
