import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWorktreeBase } from '../src/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const temps: string[] = [];
function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

function initRepo(defaultBranch: string): string {
  const dir = mkTemp('af-wtbase-');
  git(dir, 'init', '-b', defaultBranch);
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  return dir;
}

/** Bare origin with `${repo}`'s default branch pushed, so origin/<default> tracking exists. */
function addOriginAndPush(repo: string, branch: string): void {
  const bare = mkTemp('af-wtorigin-');
  git(bare, 'init', '--bare', '-b', branch);
  git(repo, 'remote', 'add', 'origin', bare);
  git(repo, 'push', '-u', 'origin', branch);
}

beforeEach(() => { temps.length = 0; });
afterEach(() => {
  for (const d of temps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('resolveWorktreeBase', () => {
  it('repo with origin + pushed main → origin/main, fetch first (latest pushed main)', async () => {
    const repo = initRepo('main');
    addOriginAndPush(repo, 'main');
    expect(await resolveWorktreeBase(repo)).toEqual({ ref: 'origin/main', fetch: true });
  });

  it('honors origin/HEAD when set (default branch is not literally "main")', async () => {
    const repo = initRepo('trunk');
    addOriginAndPush(repo, 'trunk');
    git(repo, 'remote', 'set-head', 'origin', 'trunk'); // sets refs/remotes/origin/HEAD
    expect(await resolveWorktreeBase(repo)).toEqual({ ref: 'origin/trunk', fetch: true });
  });

  it('local-only repo on master (no origin) → local master, no fetch', async () => {
    const repo = initRepo('master');
    expect(await resolveWorktreeBase(repo)).toEqual({ ref: 'master', fetch: false });
  });

  it('non-default branch name with no origin and no main/master → null (fall back to HEAD)', async () => {
    const repo = initRepo('develop');
    expect(await resolveWorktreeBase(repo)).toBeNull();
  });

  it('a directory that is not a git repo → null', async () => {
    const dir = mkTemp('af-notrepo-');
    expect(await resolveWorktreeBase(dir)).toBeNull();
  });

  it('a path that does not exist → null', async () => {
    expect(await resolveWorktreeBase(join(tmpdir(), 'af-does-not-exist-xyz'))).toBeNull();
  });
});
