import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { remoteBranchHead, revisionDiff } from '../src/git.js';

// A throwaway clone with a local bare origin — no network, no user repository.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'init.defaultBranch=main', ...args], { cwd, encoding: 'utf8' }).trim();

let root: string;
let clone: string;
let first: string;
let base: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'af-rev-'));
  const origin = join(root, 'origin.git');
  clone = join(root, 'clone');
  git(root, 'init', '--bare', origin);
  git(root, 'clone', origin, clone);
  writeFileSync(join(clone, 'a.txt'), 'one\n');
  git(clone, 'add', '.');
  git(clone, 'commit', '-m', 'base');
  git(clone, 'push', 'origin', 'HEAD:main');
  base = git(clone, 'rev-parse', 'HEAD');
  git(clone, 'checkout', '-b', 'feature/x');
  writeFileSync(join(clone, 'a.txt'), 'two\n');
  git(clone, 'commit', '-am', 'first');
  git(clone, 'push', 'origin', 'feature/x');
  first = git(clone, 'rev-parse', 'HEAD');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('remoteBranchHead', () => {
  it('reads the branch head on origin and sees a later push', async () => {
    expect(await remoteBranchHead(clone, 'feature/x')).toEqual({ headSha: first, error: null });
    writeFileSync(join(clone, 'a.txt'), 'three\n');
    git(clone, 'commit', '-am', 'second');
    git(clone, 'push', 'origin', 'feature/x');
    const second = git(clone, 'rev-parse', 'HEAD');
    expect(await remoteBranchHead(clone, 'feature/x')).toEqual({ headSha: second, error: null });
  });

  it('reports, rather than throws, a branch missing on origin or an unreachable origin', async () => {
    expect(await remoteBranchHead(clone, 'feature/missing')).toMatchObject({ headSha: null, error: expect.stringMatching(/not on origin/) });
    const lonely = join(root, 'lonely');
    git(root, 'init', lonely);
    expect(await remoteBranchHead(lonely, 'feature/x')).toMatchObject({ headSha: null, error: 'origin unreachable' });
    expect(await remoteBranchHead(clone, '--upload-pack=evil')).toMatchObject({ headSha: null });
  });
});

describe('revisionDiff', () => {
  it('reproduces the submitted snapshot after the branch moved on', async () => {
    const d = await revisionDiff(clone, base, first);
    expect(d).toMatchObject({ headSha: first, baseSha: base, commits: 1 });
    expect(d.diff).toContain('+two');
    expect(d.diff).not.toContain('three');
  });

  it('refuses non-SHA input and unknown commits', async () => {
    await expect(revisionDiff(clone, 'main', first)).rejects.toThrow(/full commit SHAs/);
    await expect(revisionDiff(clone, base, 'f'.repeat(40))).rejects.toThrow(/not in the board's repository/);
  });
});
