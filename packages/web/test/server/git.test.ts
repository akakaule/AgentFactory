import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NotFoundError, ValidationError } from '@agentfactory/core';
import { resolveBaseRef, branchDiff, GitError } from '../../server/git.js';
import { gitIn, initGitRepo, commitFile, addBranchWithChange, cleanupRepo } from './helpers/gitFixtures.js';

const dirs: string[] = [];
const track = (dir: string) => { dirs.push(dir); return dir; };
const repo = (opts?: { defaultBranch?: string }) => track(initGitRepo(opts));
afterEach(() => { while (dirs.length) cleanupRepo(dirs.pop()!); });

describe('resolveBaseRef', () => {
  it('resolves local main', async () => {
    expect(await resolveBaseRef(repo())).toBe('main');
  });

  it('falls back to master when main is absent', async () => {
    expect(await resolveBaseRef(repo({ defaultBranch: 'master' }))).toBe('master');
  });

  it('prefers origin/HEAD over local branches', async () => {
    const dir = repo();
    const sha = gitIn(dir, 'rev-parse', 'HEAD').trim();
    gitIn(dir, 'update-ref', 'refs/remotes/origin/main', sha);
    gitIn(dir, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
    expect(await resolveBaseRef(dir)).toBe('origin/main');
  });

  it('throws GitError when no base is resolvable', async () => {
    await expect(resolveBaseRef(repo({ defaultBranch: 'trunk' }))).rejects.toBeInstanceOf(GitError);
  });

  it('throws GitError for a directory that is not a repo', async () => {
    const dir = track(mkdtempSync(join(tmpdir(), 'af-norepo-')));
    await expect(resolveBaseRef(dir)).rejects.toBeInstanceOf(GitError);
  });

  it('throws GitError for a missing path', async () => {
    await expect(resolveBaseRef(join(tmpdir(), 'af-does-not-exist-xyz'))).rejects.toBeInstanceOf(GitError);
  });
});

describe('branchDiff', () => {
  it('diffs a branch against the merge-base (excludes later main commits)', async () => {
    const dir = repo();
    addBranchWithChange(dir, 'task/AF-1', 'feature.txt', 'agent work\n');
    commitFile(dir, 'mainline.txt', 'landed on main after branch point\n');

    const { baseRef, diff } = await branchDiff(dir, 'task/AF-1');
    expect(baseRef).toBe('main');
    expect(diff).toContain('feature.txt');
    expect(diff).toContain('+agent work');
    expect(diff).not.toContain('mainline.txt');
  });

  it('returns an empty diff for a branch even with base', async () => {
    const dir = repo();
    gitIn(dir, 'branch', 'task/AF-2');
    const { diff } = await branchDiff(dir, 'task/AF-2');
    expect(diff).toBe('');
  });

  it('detects renames', async () => {
    const dir = repo();
    gitIn(dir, 'switch', '-c', 'task/AF-3');
    gitIn(dir, 'mv', 'README.md', 'RENAMED.md');
    gitIn(dir, 'commit', '-m', 'rename');
    gitIn(dir, 'switch', 'main');

    const { diff } = await branchDiff(dir, 'task/AF-3');
    expect(diff).toContain('rename from README.md');
    expect(diff).toContain('rename to RENAMED.md');
  });

  it('throws NotFoundError for a branch the repo does not have', async () => {
    await expect(branchDiff(repo(), 'task/AF-404')).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each(['--output=evil', 'a..b', '-leading-dash', 'has space', 'wild*card'])(
    'rejects hostile or malformed ref %j before touching git',
    async (label) => {
      // Nonexistent path: validation must fire before any filesystem/git access,
      // otherwise this would surface as GitError instead of ValidationError.
      const missing = join(tmpdir(), 'af-does-not-exist-xyz');
      await expect(branchDiff(missing, label)).rejects.toBeInstanceOf(ValidationError);
    },
  );
});
