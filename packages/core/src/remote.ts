/**
 * Git-host detection for delivery verification. `parseRemoteUrl` is a pure classifier from an
 * origin URL to a provider reference (GitHub / Azure DevOps); `resolveOriginUrl` is the ONLY
 * local-git touch in the delivery feature, deliberately isolated to one function: a future
 * remote deployment swaps it for a stored `workspace.origin_url` without touching any caller
 * (ops/reviewApprove.ts and the watcher's self-heal both take it as an injected resolver).
 */
import { execFileSync } from 'node:child_process';
import { isAbsolute } from 'node:path';

export type RemoteRef =
  | { provider: 'github'; owner: string; repo: string }
  | { provider: 'azdo'; organization: string; project: string; repo: string };

const strip = (s: string): string => s.replace(/\.git$/i, '').replace(/\/+$/, '');
const dec = (s: string): string => {
  try { return decodeURIComponent(s); } catch { return s; }
};

/**
 * Classify a git remote URL. Host-anchored (never matches on a path substring) and covers the
 * forms git actually emits: GitHub https / ssh:// / scp-like; Azure DevOps dev.azure.com
 * (with optional user@), {org}.visualstudio.com (with optional DefaultCollection), and the
 * ssh v3 forms. Anything else — including no URL at all — is null: the approve path then
 * closes straight to done, exactly the pre-#18 behavior.
 */
export function parseRemoteUrl(url: string): RemoteRef | null {
  const u = strip(url.trim());
  if (!u) return null;

  // GitHub: https://github.com/o/r | ssh://git@github.com/o/r | git@github.com:o/r
  let m =
    /^https?:\/\/(?:[^@/]+@)?github\.com\/([^/]+)\/([^/]+)$/i.exec(u) ??
    /^ssh:\/\/(?:[^@/]+@)?github\.com(?::\d+)?\/([^/]+)\/([^/]+)$/i.exec(u) ??
    /^[^@/]+@github\.com:([^/]+)\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'github', owner: dec(m[1]!), repo: dec(m[2]!) };

  // Azure DevOps https: https://[user@]dev.azure.com/org/project/_git/repo
  m = /^https?:\/\/(?:[^@/]+@)?dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azdo', organization: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) };

  // Legacy visualstudio.com: https://org.visualstudio.com[/DefaultCollection]/project/_git/repo
  m = /^https?:\/\/(?:[^@/]+@)?([^./]+)\.visualstudio\.com\/(?:DefaultCollection\/)?([^/]+)\/_git\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azdo', organization: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) };

  // Azure DevOps ssh: git@ssh.dev.azure.com:v3/org/project/repo | ssh://git@ssh.dev.azure.com[:22]/v3/org/project/repo
  m =
    /^[^@/]+@ssh\.dev\.azure\.com:v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(u) ??
    /^ssh:\/\/(?:[^@/]+@)?ssh\.dev\.azure\.com(?::\d+)?\/v3\/([^/]+)\/([^/]+)\/([^/]+)$/i.exec(u);
  if (m) return { provider: 'azdo', organization: dec(m[1]!), project: dec(m[2]!), repo: dec(m[3]!) };

  return null;
}

/**
 * The workspace repo's `origin` URL, or null when there is no repo/remote/git — never throws.
 * Relative repoPaths (the seeded default workspace's '.') resolve to null: they depend on the
 * calling process's cwd, which is meaningless for a multi-process board — the same fail-open
 * convention as the MCP submit guardrails. A workspace that should deliver names an absolute path.
 */
export function resolveOriginUrl(repoPath: string): string | null {
  if (!isAbsolute(repoPath)) return null;
  try {
    const out = execFileSync('git', ['remote', 'get-url', 'origin'], {
      cwd: repoPath, encoding: 'utf8', timeout: 5_000, windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out || null;
  } catch {
    return null;
  }
}
