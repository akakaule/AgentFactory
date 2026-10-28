import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { NotFoundError, ValidationError } from './errors.js';

const execFileAsync = promisify(execFile);

/** Environment/repo problems the human must fix (mapped to 422), as opposed to bad input. */
export class GitError extends Error { name = 'GitError'; }

export interface BranchDiff { baseRef: string; diff: string; commits: number; headSha?: string; baseSha?: string; }

// Branch refs arrive as agent-submitted link labels — untrusted. They're passed to git
// as a single argv token (execFile, no shell) and interpolated into a '+<ref>:refs/...'
// refspec, so the guard rejects exactly what would break that or inject: a leading '-'
// (option injection), '..'/'@{' (revision ranges / reflog peel), and the characters git
// itself forbids in a ref name — whitespace, control/DEL, and ': ? * [ \ ^ ~'. Everything
// else git permits passes, so real-world branches with '&', '(', ')', or non-ASCII letters
// (e.g. 'mængder') diff correctly instead of stranding on a too-narrow ASCII allowlist.
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\x00-\x20\x7f:?*[\\^~]+$/;

/** Whether `ref` passes the SAFE_REF guard (safe as one git argv token / refspec component). */
export function isSafeRef(ref: string): boolean {
  return SAFE_REF.test(ref);
}

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

interface RunGitOptions {
  /** Kill git after this many ms (result: `timedOut`). Unset = no limit, as for local-only calls. */
  timeoutMs?: number;
  /** Extra environment, e.g. to forbid credential prompts on a network call. */
  env?: Record<string, string>;
}

/** Network git calls on a request path must never wait on a human: no terminal or GCM prompts. */
const NON_INTERACTIVE_ENV = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
const REMOTE_HEAD_TIMEOUT_MS = 15_000;

async function runGit(repoPath: string, args: string[], opts: RunGitOptions = {}): Promise<{ ok: boolean; stdout: string; timedOut?: boolean }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      maxBuffer: MAX_DIFF_BYTES,
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', ...opts.env },
      ...(opts.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException & { killed?: boolean };
    // existsSync(repoPath) ran before any spawn, so ENOENT can only mean the binary.
    if (e.code === 'ENOENT') throw new GitError('git executable not found');
    if (e.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new GitError('diff too large to display');
    return { ok: false, stdout: '', ...(opts.timeoutMs !== undefined && e.killed ? { timedOut: true } : {}) };
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
  const exists = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${branch}^{commit}`]);
  if (!exists.ok) throw new NotFoundError(`branch not found in repository: ${branch}`);
  const base = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `${baseRef}^{commit}`]);
  if (!base.ok) throw new GitError(`cannot resolve base commit: ${baseRef}`);
  const headSha = exists.stdout.trim();
  const baseSha = base.stdout.trim();
  const diff = await runGit(repoPath, [
    '-c', 'core.quotepath=false',
    'diff', '--no-color', '--no-ext-diff', '--find-renames',
    '--end-of-options', `${baseSha}...${headSha}`, '--',
  ]);
  if (!diff.ok) throw new GitError(`git diff failed for ${baseRef}...${branch}`);
  const count = await runGit(repoPath, ['rev-list', '--count', '--end-of-options', `${baseSha}..${headSha}`, '--']);
  if (!count.ok) throw new GitError(`git rev-list failed for ${baseRef}..${branch}`);
  return { baseRef, diff: diff.stdout, commits: parseInt(count.stdout.trim(), 10) || 0, headSha, baseSha };
}

/** What `remoteBranchHead` saw: the branch's head on origin, or why it could not be read. */
export interface RemoteHead { headSha: string | null; error: string | null; }

/**
 * Observe a branch's current head on origin (`git ls-remote`, nothing fetched) — the approve-time
 * refresh that tells a reviewed submission from a later push. Never throws for an unreachable or
 * misconfigured remote: the failure is returned so the board can show unknown freshness. With a
 * resolved workspace credential the bare origin URL is queried with an `http.extraheader` (the
 * inherited key is reset first so an injected header cannot be sent twice). It runs on the approve
 * request path, so it never prompts for credentials and gives up after `timeoutMs` — a hung origin
 * reads as unknown freshness instead of approving long after the client gave up.
 */
export async function remoteBranchHead(repoPath: string, branch: string, auth: { remoteUrl: string; configKey: string; configValue: string } | null = null, opts: { timeoutMs?: number } = {}): Promise<RemoteHead> {
  if (!SAFE_REF.test(branch)) return { headSha: null, error: `branch ref is not checkable: ${branch}` };
  if (!existsSync(repoPath)) return { headSha: null, error: `repository path does not exist: ${repoPath}` };
  const authArgs = auth ? ['-c', `${auth.configKey}=`, '-c', `${auth.configKey}=${auth.configValue}`] : [];
  let r: { ok: boolean; stdout: string; timedOut?: boolean };
  try {
    r = await runGit(repoPath, [...authArgs, 'ls-remote', '--heads', '--end-of-options', auth ? auth.remoteUrl : 'origin', `refs/heads/${branch}`],
      { timeoutMs: opts.timeoutMs ?? REMOTE_HEAD_TIMEOUT_MS, env: NON_INTERACTIVE_ENV });
  } catch (err) {
    return { headSha: null, error: (err as Error).message };
  }
  if (r.timedOut) return { headSha: null, error: 'origin timed out' };
  if (!r.ok) return { headSha: null, error: 'origin unreachable' };
  const sha = r.stdout.trim().split(/\s+/)[0] ?? '';
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { headSha: null, error: `branch ${branch} is not on origin` };
  return { headSha: sha, error: null };
}

/**
 * The diff of one recorded revision — `base..head` exactly as submitted — so the reviewed snapshot
 * stays reproducible after the branch moved or the worktree was removed. Both ids must be full SHAs
 * (they come from task_submission, never from a request).
 */
export async function revisionDiff(repoPath: string, baseSha: string, headSha: string): Promise<BranchDiff> {
  const sha = /^[0-9a-f]{40}([0-9a-f]{24})?$/;
  if (!sha.test(baseSha) || !sha.test(headSha)) throw new ValidationError('revision diff needs full commit SHAs');
  if (!existsSync(repoPath)) throw new GitError(`repository path does not exist: ${repoPath}`);
  for (const id of [baseSha, headSha]) {
    const has = await runGit(repoPath, ['cat-file', '-e', '--end-of-options', `${id}^{commit}`]);
    if (!has.ok) throw new NotFoundError(`commit ${id.slice(0, 7)} is not in the board's repository (fetch the branch)`);
  }
  const diff = await runGit(repoPath, ['-c', 'core.quotepath=false', 'diff', '--no-color', '--no-ext-diff', '--find-renames', '--end-of-options', `${baseSha}..${headSha}`, '--']);
  if (!diff.ok) throw new GitError(`git diff failed for ${baseSha.slice(0, 7)}..${headSha.slice(0, 7)}`);
  const count = await runGit(repoPath, ['rev-list', '--count', '--end-of-options', `${baseSha}..${headSha}`, '--']);
  return { baseRef: baseSha, diff: diff.stdout, commits: parseInt(count.stdout.trim(), 10) || 0, headSha, baseSha };
}
