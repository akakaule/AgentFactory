import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

// Pin identity/signing per call so user/CI git config can't interfere with fixtures.
const PINNED = ['-c', 'user.email=test@example.com', '-c', 'user.name=test', '-c', 'commit.gpgsign=false'];

export function gitIn(dir: string, ...args: string[]): string {
  return execFileSync('git', [...PINNED, ...args], { cwd: dir, encoding: 'utf8', windowsHide: true });
}

/** Temp repo with one seed commit on the given default branch (default: main). */
export function initGitRepo(opts: { defaultBranch?: string } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), 'af-git-'));
  gitIn(dir, 'init', '-b', opts.defaultBranch ?? 'main');
  commitFile(dir, 'README.md', '# fixture\n', 'seed');
  return dir;
}

export function commitFile(dir: string, file: string, content: string, msg = `edit ${file}`): void {
  const p = join(dir, file);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  gitIn(dir, 'add', '--', file);
  gitIn(dir, 'commit', '-m', msg);
}

/** Branch off HEAD, commit one change, switch back to the original branch. */
export function addBranchWithChange(dir: string, branch: string, file: string, content: string): void {
  const prev = gitIn(dir, 'rev-parse', '--abbrev-ref', 'HEAD').trim();
  gitIn(dir, 'switch', '-c', branch);
  commitFile(dir, file, content);
  gitIn(dir, 'switch', prev);
}

export function cleanupRepo(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
