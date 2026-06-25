import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectGitHubRemote } from '../src/git.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const temps: string[] = [];
function mkRepo(origin?: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'af-gh-')));
  temps.push(dir);
  git(dir, 'init', '-b', 'main');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'commit', '--allow-empty', '-m', 'init');
  if (origin) git(dir, 'remote', 'add', 'origin', origin);
  return dir;
}

beforeEach(() => { temps.length = 0; });
afterEach(() => {
  for (const d of temps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe('detectGitHubRemote', () => {
  it('detects an https github origin and resolves the default branch', async () => {
    const repo = mkRepo('https://github.com/org/repo.git');
    expect(await detectGitHubRemote(repo)).toEqual({ defaultBranch: 'main' });
  });

  it('detects an ssh (scp-style) github origin', async () => {
    const repo = mkRepo('git@github.com:org/repo.git');
    expect(await detectGitHubRemote(repo)).toEqual({ defaultBranch: 'main' });
  });

  it('returns null for a non-github origin (host-anchored, not a substring match)', async () => {
    expect(await detectGitHubRemote(mkRepo('https://gitlab.com/org/repo.git'))).toBeNull();
    expect(await detectGitHubRemote(mkRepo('https://notgithub.com/org/repo.git'))).toBeNull();
  });

  it('returns null when there is no origin remote', async () => {
    expect(await detectGitHubRemote(mkRepo())).toBeNull();
  });

  it('returns null for a path that is not a repo', async () => {
    expect(await detectGitHubRemote(join(tmpdir(), 'af-gh-does-not-exist-xyz'))).toBeNull();
  });
});
