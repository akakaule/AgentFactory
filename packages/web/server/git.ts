import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { NotFoundError, ValidationError } from '@agentfactory/core';

const execFileAsync = promisify(execFile);

/** Environment/repo problems the human must fix (mapped to 422), as opposed to bad input. */
export class GitError extends Error { name = 'GitError'; }

export interface BranchDiff { baseRef: string; diff: string; }

// Branch refs arrive as agent-submitted link labels — untrusted. No leading '-'
// (option injection), no '..' (revision ranges), conservative charset.
const SAFE_REF = /^(?!-)(?!.*\.\.)[\w./-]+$/;

const MAX_DIFF_BYTES = 32 * 1024 * 1024;

async function runGit(repoPath: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: MAX_DIFF_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // existsSync(repoPath) ran before any spawn, so ENOENT can only mean the binary.
    if (e.code === 'ENOENT') throw new GitError('git executable not found');
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitError('diff too large to display');
    return { ok: false, stdout: '' };
  }
}

export async function resolveBaseRef(repoPath: string): Promise<string> {
  if (!existsSync(repoPath)) throw new GitError(`repository path does not exist: ${repoPath}`);
  if (!(await runGit(repoPath, ['rev-parse', '--git-dir'])).ok) {
    throw new GitError(`not a git repository: ${repoPath}`);
  }
  const originHead = await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (originHead.ok) return originHead.stdout.trim().replace(/^refs\/remotes\//, '');
  for (const name of ['main', 'master']) {
    if ((await runGit(repoPath, ['rev-parse', '--verify', '--quiet', name])).ok) return name;
  }
  throw new GitError('cannot determine default branch (no origin/HEAD, main, or master)');
}

/** Merge-base diff of a branch against the repo's default branch. */
export async function branchDiff(repoPath: string, branch: string): Promise<BranchDiff> {
  if (!SAFE_REF.test(branch)) throw new ValidationError(`invalid branch ref: ${branch}`);
  const baseRef = await resolveBaseRef(repoPath);
  const exists = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', branch]);
  if (!exists.ok) throw new NotFoundError(`branch not found in repository: ${branch}`);
  const diff = await runGit(repoPath, [
    '-c', 'core.quotepath=false',
    'diff', '--no-color', '--no-ext-diff', '--find-renames',
    '--end-of-options', `${baseRef}...${branch}`, '--',
  ]);
  if (!diff.ok) throw new GitError(`git diff failed for ${baseRef}...${branch}`);
  return { baseRef, diff: diff.stdout };
}
