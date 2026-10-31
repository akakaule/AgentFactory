/**
 * Probe a workspace's managed git credential the way a worker uses it: `git ls-remote` against the
 * bare origin with only the injected `http.<origin>.extraheader` — no credential helper, no prompt —
 * so a rejected PAT fails fast instead of falling back to Git Credential Manager and hanging. For a
 * GitHub credential that works, one REST call reads the token's expiry date from the
 * `github-authentication-token-expiration` response header (Azure DevOps exposes no equivalent).
 */
import { execFile } from 'node:child_process';
import type { CredentialCheck } from './credentialHealth.js';
import { gitAuthConfigPairs, type GitAuth } from './gitAuth.js';
import { parseRemoteUrl } from './remote.js';

export type ProbeRun = (args: string[], env: NodeJS.ProcessEnv, timeoutMs: number) => Promise<{ ok: boolean; stderr: string; timedOut?: boolean }>;
export type ProbeFetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; headers: { get(name: string): string | null } }>;

export interface ProbeOptions {
  run?: ProbeRun;
  fetch?: ProbeFetch;
  timeoutMs?: number;
  githubApiBase?: string;
}

const AUTH_FAILURE = /authentication failed|could not read username|terminal prompts disabled|access denied|not authorized|error: 40[13]\b|\b40[13]\b/i;

const defaultRun: ProbeRun = (args, env, timeoutMs) => new Promise((resolve) => {
  execFile('git', args, { env, timeout: timeoutMs, windowsHide: true, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    (err, _stdout, stderr) => {
      if (!err) return resolve({ ok: true, stderr: '' });
      const timedOut = (err as { killed?: boolean }).killed === true;
      resolve({ ok: false, stderr: String(stderr || err.message), timedOut });
    });
});

/** GitHub's expiry header: `2026-11-27 12:00:00 UTC` or `2026-11-27 12:00:00 +0100`. */
export function parseGithubExpiry(value: string | null): string | null {
  const m = value ? /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) (UTC|[+-]\d{4})$/.exec(value.trim()) : null;
  if (!m) return null;
  const zone = m[3] === 'UTC' ? 'Z' : `${m[3]!.slice(0, 3)}:${m[3]!.slice(3)}`;
  const ms = Date.parse(`${m[1]}T${m[2]}${zone}`);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

export async function probeCredential(auth: GitAuth, opts: ProbeOptions = {}): Promise<CredentialCheck> {
  const run = opts.run ?? defaultRun;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  for (const key of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR']) delete env[key];
  // Reset the key first so an inherited extraheader (e.g. the dispatcher's) can't add a second header.
  const n = Number(env['GIT_CONFIG_COUNT'] ?? '0') || 0;
  const pairs: Array<[string, string]> = [[auth.configKey, ''], ...gitAuthConfigPairs(auth)];
  env['GIT_CONFIG_COUNT'] = String(n + pairs.length);
  pairs.forEach(([key, value], i) => { env[`GIT_CONFIG_KEY_${n + i}`] = key; env[`GIT_CONFIG_VALUE_${n + i}`] = value; });

  const result = await run(['-c', 'credential.helper=', 'ls-remote', '--heads', auth.remoteUrl], env, timeoutMs);
  if (!result.ok) {
    if (result.timedOut) return { status: 'unreachable', error: 'git ls-remote timed out', expiresAt: null };
    const secret = auth.configValue.replace(/^authorization:\s*/i, '').replace(/^(basic|bearer)\s+/i, '');
    const error = result.stderr.replaceAll(auth.configValue, '[redacted]').replaceAll(secret, '[redacted]')
      .split('\n').map((l) => l.trim()).filter(Boolean).slice(-3).join(' | ');
    return { status: AUTH_FAILURE.test(result.stderr) ? 'failing' : 'unreachable', error: error || 'git ls-remote failed', expiresAt: null };
  }
  return { status: 'ok', error: null, expiresAt: auth.provider === 'github' ? await githubExpiry(auth, opts) : null };
}

async function githubExpiry(auth: GitAuth, opts: ProbeOptions): Promise<string | null> {
  const ref = parseRemoteUrl(auth.remoteUrl);
  if (ref?.provider !== 'github') return null;
  const doFetch = opts.fetch ?? (fetch as unknown as ProbeFetch);
  try {
    const res = await doFetch(`${opts.githubApiBase ?? 'https://api.github.com'}/repos/${ref.owner}/${ref.repo}`, {
      headers: {
        Authorization: auth.configValue.replace(/^authorization:\s*/i, ''),
        Accept: 'application/vnd.github+json', 'User-Agent': 'agentfactory-credential-monitor',
      },
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
    });
    return res.ok ? parseGithubExpiry(res.headers.get('github-authentication-token-expiration')) : null;
  } catch { return null; }
}
