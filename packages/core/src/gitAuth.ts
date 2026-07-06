/**
 * Resolve the git-host credential for a workspace and shape it as an HTTP auth header that any
 * git command can carry. One resolver, three consumers: the dispatcher injects it into the
 * worker's git env (http.extraheader), the MCP submit-verify adds it to its `ls-remote`, and the
 * watcher's REST uses the same stored PAT. Precedence: the workspace's stored PAT (DB, migration
 * #19) → the per-workspace env var → the shared base env var → null (no auth; ambient git
 * credentials apply exactly as before).
 *
 * The credential is injected as `http.<origin>.extraheader` against a BARE origin URL (userinfo
 * stripped) so the header is authoritative and any stale credential embedded in the on-disk
 * origin URL can't override it. The secret rides in git config only — never in a command line
 * that reaches an LLM transcript, never persisted to `.git/config`.
 */
import type { DB } from './db.js';
import { findWorkspaceByName } from './repo/workspaces.js';
import { parseRemoteUrl, resolveOriginUrl } from './remote.js';
import { perWorkspaceEnvVar, BASE_ENV_VAR } from './patEnv.js';

export interface GitAuth {
  provider: 'github' | 'azdo';
  /** Bare origin URL (userinfo stripped) — safe to log/emit; the target for network git commands. */
  remoteUrl: string;
  /** The on-disk `origin` URL as configured (may carry a stale embedded credential). Used to build a
   *  `url.<remoteUrl>.insteadOf` rewrite so a worker pushing to `origin` uses the bare URL instead. */
  originUrl: string;
  /** git config key: `http.<remoteUrl>.extraheader`. */
  configKey: string;
  /** git config value: `Authorization: Basic <base64>` — the SECRET; keep it out of logs/payloads. */
  configValue: string;
}

/**
 * The git config entries (as ordered key/value pairs) that make a worker use this managed credential:
 *   1. `http.<bare>.extraheader` — the auth header carrying the PAT.
 *   2. `url.<bare>.insteadOf` — only when the on-disk origin embeds a credential: rewrites it to the
 *      bare URL at resolution time so the extraheader is authoritative. (Overriding `remote.origin.url`
 *      via config does NOT work — it is multi-valued and appends rather than replaces.)
 * Injected via `GIT_CONFIG_*` env (worker) or `-c key=value` (server-side).
 */
export function gitAuthConfigPairs(auth: GitAuth): Array<[string, string]> {
  const pairs: Array<[string, string]> = [[auth.configKey, auth.configValue]];
  if (auth.originUrl !== auth.remoteUrl) {
    pairs.push([`url.${auth.remoteUrl}.insteadOf`, auth.originUrl]);
  }
  return pairs;
}

/** Strip `user[:pass]@` userinfo from an http(s) URL. Returns null for non-http (e.g. ssh) URLs,
 *  where a PAT-over-HTTP header doesn't apply (ssh auth is key-based). */
export function bareHttpUrl(url: string): string | null {
  const m = /^(https?:\/\/)(?:[^@/]+@)?(.+)$/i.exec(url.trim());
  return m ? `${m[1]}${m[2]}` : null;
}

function authHeaderValue(provider: 'github' | 'azdo', pat: string): string {
  // ADO: HTTP Basic, empty username + PAT as password (mirrors the watcher's azdo provider).
  // GitHub git-over-HTTPS: Basic with the token as password under the x-access-token username
  // (works for both classic/fine-grained PATs and installation tokens).
  const basic = provider === 'azdo' ? `:${pat}` : `x-access-token:${pat}`;
  return `Authorization: Basic ${Buffer.from(basic, 'utf8').toString('base64')}`;
}

export interface ResolveGitAuthOptions {
  env?: Record<string, string | undefined> | undefined;
  resolveOrigin?: ((repoPath: string) => string | null) | undefined;
}

/**
 * The git auth to use for `workspace`, or null when none resolves (no workspace, no/unrecognized/
 * non-http origin, or no PAT anywhere). Null means "do nothing" — the caller leaves git to its
 * ambient credentials, i.e. exactly today's behavior.
 */
export function resolveGitAuth(db: DB, workspace: string, opts: ResolveGitAuthOptions = {}): GitAuth | null {
  const env = opts.env ?? process.env;
  const resolveOrigin = opts.resolveOrigin ?? resolveOriginUrl;

  const row = findWorkspaceByName(db, workspace);
  if (!row) return null;

  const origin = resolveOrigin(row.repo_path);
  if (!origin) return null;
  const remoteUrl = bareHttpUrl(origin);
  if (!remoteUrl) return null; // ssh / non-http origin — header auth n/a
  const ref = parseRemoteUrl(origin);
  if (!ref) return null; // unrecognized host — can't pick a base env var

  const base = BASE_ENV_VAR[ref.provider];
  const pat = row.pat ?? env[perWorkspaceEnvVar(base, workspace)] ?? env[base] ?? null;
  if (!pat) return null;

  return {
    provider: ref.provider,
    remoteUrl,
    originUrl: origin,
    configKey: `http.${remoteUrl}.extraheader`,
    configValue: authHeaderValue(ref.provider, pat),
  };
}
