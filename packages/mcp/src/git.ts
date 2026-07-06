import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { GitAuth } from '@agentfactory/core';

const execFileAsync = promisify(execFile);

/** git couldn't run at all (binary missing) — distinct from a non-zero exit. */
export class GitError extends Error { name = 'GitError'; }

// The branch is server-generated here (never agent input), but the same injection
// discipline core uses costs nothing and keeps the guard meaning one thing everywhere:
// no leading '-', no '..'/'@{', and none of the characters git forbids in a ref name
// (whitespace, control/DEL, ': ? * [ \ ^ ~'). A name that fails is treated as un-checkable
// rather than passed to git. Mirrors SAFE_REF in @agentfactory/core (packages/core/src/git.ts).
const SAFE_REF = /^(?!-)(?!.*\.\.)(?!.*@\{)[^\x00-\x20\x7f:?*[\\^~]+$/;

/** Run a git read. `ok:false` = git ran but exited non-zero; throws GitError only if git is absent. */
async function runGit(repoPath: string, args: string[]): Promise<{ ok: boolean; stdout: string }> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoPath,
      encoding: 'utf8',
      windowsHide: true,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
    });
    return { ok: true, stdout };
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    // existsSync(repoPath) ran before any spawn, so ENOENT can only mean the binary.
    if (e.code === 'ENOENT') throw new GitError('git executable not found');
    return { ok: false, stdout: '' };
  }
}

/**
 * The ref a FRESH task branch should be created from: the latest pushed default branch.
 * Returns null when it can't be determined (not a git repo, no resolvable default) so the
 * caller falls back to plain `-b <branch>` (branch from current HEAD) rather than blocking a
 * claim. Only ever returns a ref that actually exists — we hand the worker a real ref, never a
 * guess. Preference: remote-tracking `origin/<default>` (with a fetch, so the worktree starts
 * from the latest main), else local `<default>` (no origin to fetch from).
 */
/**
 * The default branch NAME for a repo: prefer origin/HEAD, else probe local main/master.
 * Returns null when none resolves or the name fails ref-safety. Shared by worktree-base
 * resolution and GitHub PR base selection.
 */
export async function resolveDefaultBranchName(repoPath: string): Promise<string | null> {
  let name: string | null = null;
  const head = await runGit(repoPath, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD']);
  if (head.ok && head.stdout.trim()) {
    name = head.stdout.trim().replace(/^refs\/remotes\/origin\//, '');
  } else {
    for (const cand of ['main', 'master']) {
      if ((await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', cand])).ok) { name = cand; break; }
    }
  }
  return name && SAFE_REF.test(name) ? name : null;
}

export async function resolveWorktreeBase(repoPath: string): Promise<{ ref: string; fetch: boolean } | null> {
  if (!existsSync(repoPath)) return null;
  if (!(await runGit(repoPath, ['rev-parse', '--git-dir'])).ok) return null;

  const name = await resolveDefaultBranchName(repoPath);
  if (!name) return null;

  // Prefer the freshest EXISTING base: origin/<name> (refreshed by a fetch), else local <name>.
  if ((await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', `origin/${name}`])).ok) {
    return { ref: `origin/${name}`, fetch: true };
  }
  if ((await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', name])).ok) {
    return { ref: name, fetch: false };
  }
  return null;
}

// origin points at github.com — https://github.com/…, git@github.com:…, ssh://git@github.com/….
// Host-anchored (the host segment must BE github.com) so a path like notgithub.com never matches.
function isGitHubUrl(url: string): boolean {
  return /^(?:https?:\/\/|ssh:\/\/)?(?:[^@/]+@)?github\.com[/:]/i.test(url);
}

/**
 * When the repo's `origin` is a GitHub remote, the default branch to target a PR at (null when
 * it can't be resolved — the caller then lets `gh` pick the repo default). Returns null when
 * origin is absent, non-GitHub, or the repo/git is unreachable. Read-only and safe-degrading
 * like resolveWorktreeBase: detection must never block a claim.
 */
export async function detectGitHubRemote(repoPath: string): Promise<{ defaultBranch: string | null } | null> {
  if (!existsSync(repoPath)) return null;
  let url: { ok: boolean; stdout: string };
  try {
    url = await runGit(repoPath, ['remote', 'get-url', 'origin']);
  } catch (err) {
    if (err instanceof GitError) return null; // git absent
    throw err;
  }
  if (!url.ok || !isGitHubUrl(url.stdout.trim())) return null;
  return { defaultBranch: await resolveDefaultBranchName(repoPath) };
}

export interface SubmitGuardResult { ok: boolean; message?: string; }

/** A linked worktree under <repo>/.worktrees/<key> still exists (case/sep-insensitive). */
function worktreeSurvives(porcelain: string, key: string): boolean {
  const suffix = `/.worktrees/${key.toLowerCase()}`;
  return porcelain
    .split(/\r?\n/)
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).replace(/\\/g, '/').toLowerCase())
    .some((p) => p.endsWith(suffix));
}

function skip(reason: string): SubmitGuardResult {
  console.error(`[agentfactory-mcp] submit guardrail skipped: ${reason}`);
  return { ok: true };
}

/**
 * Verify the finish protocol actually ran before submit_result advances the task:
 * (1) the branch exists on origin, (2) origin is not behind local, (3) the task's
 * worktree was removed. All git *reads* — the server never mutates the repo.
 *
 * Degrades safely: a null branch (task claimed before this feature), a relative or
 * missing repoPath, or git being absent skips every check; a repo with no `origin`
 * keeps the worktree check but skips the push checks. The one place it fails *closed*
 * is a configured-but-unreachable remote — failing open there would silently re-create
 * the very incident this guards against.
 */
export async function checkSubmission(opts: { repoPath: string; branch: string | null; key: string; auth?: GitAuth | null }): Promise<SubmitGuardResult> {
  const { repoPath, branch, key, auth } = opts;

  if (branch === null) return skip(`${key} has no branch (claimed before the protocol existed)`);
  if (!repoPath || !isAbsolute(repoPath)) return skip(`repoPath is not absolute (${repoPath || '<empty>'})`);
  if (!existsSync(repoPath)) return skip(`repoPath does not exist (${repoPath})`);
  if (!SAFE_REF.test(branch)) return skip(`branch ref is not checkable (${branch})`);

  let gitDir: { ok: boolean; stdout: string };
  try {
    gitDir = await runGit(repoPath, ['rev-parse', '--git-dir']);
  } catch (err) {
    if (err instanceof GitError) return skip('git executable not found');
    throw err;
  }
  if (!gitDir.ok) return skip(`not a git repository (${repoPath})`);

  const worktree = `${repoPath}/.worktrees/${key}`;
  const failures: string[] = [];

  // (3) worktree removed
  const wt = await runGit(repoPath, ['worktree', 'list', '--porcelain']);
  if (wt.ok && worktreeSurvives(wt.stdout, key)) {
    failures.push(`the task worktree still exists — remove it:\n      git worktree remove ${worktree} && git worktree prune`);
  }

  // (1)+(2) push checks — only meaningful with an origin remote
  const remotes = await runGit(repoPath, ['remote']);
  const hasOrigin = remotes.ok && remotes.stdout.split(/\r?\n/).map((s) => s.trim()).includes('origin');
  if (hasOrigin) {
    // With a resolved workspace credential, authenticate the check with `http.<origin>.extraheader`
    // against the bare origin URL — so an expired PAT embedded in the on-disk origin URL can't 401
    // the verify. Without one, fall back to `origin` and whatever ambient credential git resolves.
    const target = auth ? auth.remoteUrl : 'origin';
    const authArgs = auth ? ['-c', `${auth.configKey}=${auth.configValue}`] : [];
    const ls = await runGit(repoPath, [...authArgs, 'ls-remote', '--heads', '--end-of-options', target, branch]);
    if (!ls.ok) {
      // configured but unreachable — fail closed; the push needed this same network moments ago
      failures.push(`origin is configured but unreachable, so the push could not be verified — retry submit once the remote responds.`);
    } else if (ls.stdout.trim() === '') {
      failures.push(`branch ${branch} is not on origin — push it:\n      git push -u origin ${branch}`);
    } else {
      const remoteSha = ls.stdout.trim().split(/\s+/)[0] ?? '';
      const local = await runGit(repoPath, ['rev-parse', '--verify', '--quiet', '--end-of-options', branch]);
      const localSha = local.stdout.trim();
      if (local.ok && localSha && localSha !== remoteSha) {
        failures.push(`origin/${branch} is behind your local branch — push the latest commits:\n      git push origin ${branch}`);
      }
    }
  } else {
    console.error(`[agentfactory-mcp] submit guardrail: no origin remote in ${repoPath} — push checks skipped`);
  }

  if (failures.length > 0) {
    return {
      ok: false,
      message:
        `Submission blocked — the finish protocol is not complete for ${branch}:\n\n` +
        failures.map((f) => `  • ${f}`).join('\n\n') +
        `\n\nFix the above, then call submit_result again.`,
    };
  }
  return { ok: true };
}
