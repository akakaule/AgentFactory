import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { NotFoundError, ValidationError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Environment/repo problems the human must fix (mapped to 422), as opposed to bad input. */
export class GitError extends Error { name = 'GitError'; }

export interface BranchDiff { baseRef: string; diff: string; commits: number; }

// Branch refs arrive as agent-submitted link labels — untrusted. They're passed to git
// as a single argv token (execFile, no shell) and interpolated into a '+<ref>:refs/...'
// refspec, so the guard rejects exactly what would break that or inject: a leading '-'
// (option injection), '..'/'@{' (revision ranges / reflog peel), and the characters git
// itself forbids in a ref name — whitespace, control/DEL, and ': ? * [ \ ^ ~'. Everything
// else git permits passes, so real-world branches with '&', '(', ')', or non-ASCII letters
// (e.g. 'mængder') diff correctly instead of stranding on a too-narrow ASCII allowlist.
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\x00-\x20\x7f:?*[\\^~]+$/;

/**
 * A branch-kind link's label is the display string an agent submits. By convention it
 * starts with the bare branch ref, but agents sometimes decorate it with a trailing
 * annotation, e.g. `feature/AF-18-... (PR 4703 source — conflict fix pushed here)`. The
 * whole label must never reach git as a ref (it fails SAFE_REF and strands the diff /
 * auto-review). Recover the leading whitespace-delimited token, returning it only if it
 * is a safe ref; else null (callers decide whether to surface the bad label or skip).
 */
export function refFromLabel(label: string): string | null {
  const head = label.trim().split(/\s+/)[0] ?? '';
  return SAFE_REF.test(head) ? head : null;
}

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

/**
 * Fetch one branch from origin into its remote-tracking ref (refs/remotes/origin/<ref>) so a ref
 * that isn't in the local store — a teammate's PR head — becomes resolvable for branchDiff (which is
 * then called with `origin/<ref>`). Force-updates the tracking ref (`+`) so a force-pushed PR head
 * still lands. SAFE_REF-guarded: `ref` is an untrusted, branch-link-sourced value.
 *
 * The fetch SOURCE is qualified to `refs/heads/<ref>` (a bare ref is a branch name). Without this a
 * pseudo-ref like `@` or `HEAD` would make `git fetch origin <ref>` resolve the remote's default
 * HEAD instead of the submitted PR head — the diff would then silently compare the default branch
 * against itself and report a clean review. Qualifying makes such a ref a (non-existent) branch
 * name, so the fetch fails loudly rather than reviewing the wrong thing.
 */
export async function fetchRemoteRef(repoPath: string, ref: string): Promise<void> {
  if (!SAFE_REF.test(ref)) throw new ValidationError(`invalid branch ref: ${ref}`);
  if (!existsSync(repoPath)) throw new GitError(`repository path does not exist: ${repoPath}`);
  const src = ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
  const r = await runGit(repoPath, ['fetch', '--quiet', 'origin', `+${src}:refs/remotes/origin/${ref}`]);
  if (!r.ok) throw new GitError(`git fetch failed for origin ${ref}`);
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
  const count = await runGit(repoPath, ['rev-list', '--count', '--end-of-options', `${baseRef}..${branch}`, '--']);
  if (!count.ok) throw new GitError(`git rev-list failed for ${baseRef}..${branch}`);
  return { baseRef, diff: diff.stdout, commits: parseInt(count.stdout.trim(), 10) || 0 };
}
