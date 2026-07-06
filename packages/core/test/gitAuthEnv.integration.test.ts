/**
 * Real-git proof that the config `gitAuthConfigPairs` emits is actually honored by git — that a
 * worker whose origin embeds a stale credential still reaches the bare target via url.insteadOf,
 * with the managed-PAT extraheader riding along. This guards the subtlety that overriding
 * `remote.origin.url` via GIT_CONFIG does NOT work (it is multi-valued and appends), which unit
 * tests asserting env vars alone would miss.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gitAuthConfigPairs, type GitAuth } from '../src/gitAuth.js';

const BRANCH = 'feature/AF-91';

function git(cwd: string, env: NodeJS.ProcessEnv | undefined, ...args: string[]): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** Turn config pairs into the GIT_CONFIG_* env the dispatcher hands a worker. */
function gitConfigEnv(pairs: Array<[string, string]>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CONFIG_COUNT: String(pairs.length) };
  pairs.forEach(([k, v], i) => { env[`GIT_CONFIG_KEY_${i}`] = k; env[`GIT_CONFIG_VALUE_${i}`] = v; });
  return env;
}

const temps: string[] = [];
function mkTemp(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  temps.push(dir);
  return dir;
}

beforeEach(() => { temps.length = 0; });
afterEach(() => {
  for (const d of temps.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* best effort on Windows */ }
  }
});

describe('gitAuthConfigPairs — real git honors the emitted config', () => {
  it('insteadOf rewrites an embedded-credential origin to the reachable bare target, for fetch and push', () => {
    // a bare "origin" reachable at a local path, seeded with the branch (forward-slashed for git-on-Windows)
    const bareUrl = mkTemp('af-bare-').replace(/\\/g, '/');
    git(bareUrl, undefined, 'init', '--bare', '-b', 'main');
    const work = mkTemp('af-work-');
    git(work, undefined, 'init', '-b', 'main');
    git(work, undefined, 'config', 'user.email', 't@e.com');
    git(work, undefined, 'config', 'user.name', 'T');
    git(work, undefined, 'commit', '--allow-empty', '-m', 'init');
    git(work, undefined, 'checkout', '-b', BRANCH);
    git(work, undefined, 'commit', '--allow-empty', '-m', 'work');
    git(work, undefined, 'push', bareUrl, BRANCH);

    // a repo whose origin embeds a bogus credential pointing at an unreachable host — exactly the
    // shape that 401'd for the user (only here the host is unresolvable so no network is touched).
    const repo = mkTemp('af-repo-');
    git(repo, undefined, 'init', '-b', 'main');
    const embedded = 'https://expiredpat@example.invalid/Org/_git/Repo';
    git(repo, undefined, 'remote', 'add', 'origin', embedded);

    const auth: GitAuth = {
      provider: 'azdo',
      remoteUrl: bareUrl, // stands in for the reachable bare URL
      originUrl: embedded, // the stale embedded-credential origin
      configKey: `http.${bareUrl}.extraheader`,
      configValue: 'Authorization: Basic ' + Buffer.from(':stored-pat', 'utf8').toString('base64'),
    };
    const env = gitConfigEnv(gitAuthConfigPairs(auth));

    // fetch: `origin` (unreachable example.invalid) resolves to the bare target only via insteadOf —
    // seeing the branch proves the rewrite fired (and the extraheader was harmless on file transport).
    const heads = git(repo, env, 'ls-remote', '--heads', 'origin');
    expect(heads).toContain(`refs/heads/${BRANCH}`);

    // push: a new commit pushed through `origin` must land on the bare target (insteadOf covers push).
    git(repo, undefined, 'fetch', bareUrl, `${BRANCH}:${BRANCH}`);
    git(repo, undefined, 'checkout', BRANCH);
    git(repo, undefined, 'commit', '--allow-empty', '-m', 'from-repo-through-origin');
    const localSha = git(repo, undefined, 'rev-parse', BRANCH).trim();
    git(repo, env, 'push', 'origin', BRANCH);
    expect(git(bareUrl, undefined, 'rev-parse', BRANCH).trim()).toBe(localSha);
  }, 20_000);
});
