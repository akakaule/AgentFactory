/**
 * Read-only workspace diagnostics (AF-151): check a workspace's setup before agents fail on it.
 * Every check reports `ok`, `failed` (it ran and found a problem) or `not_applicable` (it does not
 * apply, or a capability it needs is missing — `blockedBy` then names the check it depends on), each
 * with a reason. Nothing here writes, and no secret is ever reported: the PAT is used only as a
 * request header and an origin URL is reported with its userinfo stripped.
 *
 * All process / filesystem / network access goes through injectable `DiagnoseProbes`, so tests run
 * against stubs and the board server supplies the real ones (`defaultDiagnoseProbes`).
 */
import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import type { Workspace } from './types.js';
import { parseRemoteUrl, type RemoteRef } from './remote.js';
import { bareHttpUrl } from './gitAuth.js';
import { perWorkspaceEnvVar, BASE_ENV_VAR } from './patEnv.js';
import { isSafeRef } from './git.js';

export type DiagnosticId = 'repo_path' | 'git' | 'node' | 'origin' | 'base_ref' | 'verify_command' | 'pat' | 'host_checks';
export type DiagnosticStatus = 'ok' | 'failed' | 'not_applicable';
export interface DiagnosticCheck {
  id: DiagnosticId;
  label: string;
  status: DiagnosticStatus;
  reason: string;
  /** The observed value (resolved path, bare origin URL, base branch, tool version, …) — never a secret. */
  detail?: string;
  /** Set on `not_applicable` when a check could not run because the named check did not pass. */
  blockedBy?: DiagnosticId;
}
export interface WorkspaceDiagnosis { workspace: string; repoPath: string; checks: DiagnosticCheck[] }

export interface DiagnoseProbes {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  /** Run an executable without a shell. `missing` = the executable itself was not found. */
  exec(file: string, args: string[], cwd?: string): Promise<{ ok: boolean; stdout: string; missing: boolean }>;
  /** The existing path with its exact on-disk case, or null when nothing is there. */
  realPath(p: string): string | null;
  /** Whether a regular file exists at `p`. */
  fileExists(p: string): boolean;
  fetch(url: string, init: { headers: Record<string, string> }): Promise<{ status: number }>;
}

const LABELS: Record<DiagnosticId, string> = {
  repo_path: 'Repository path',
  git: 'git available',
  node: 'node available',
  origin: 'Origin remote',
  base_ref: 'Base branch resolves',
  verify_command: 'Verify command executable',
  pat: 'Git PAT configured',
  host_checks: 'Host check access',
};

export async function diagnoseWorkspace(
  input: { workspace: Workspace; pat: string | null },
  probes: DiagnoseProbes = defaultDiagnoseProbes(),
): Promise<WorkspaceDiagnosis> {
  const { workspace: ws, pat } = input;
  const out = new Map<DiagnosticId, DiagnosticCheck>();
  const put = (id: DiagnosticId, status: DiagnosticStatus, reason: string, extra: { detail?: string | undefined; blockedBy?: DiagnosticId } = {}) => {
    const c: DiagnosticCheck = { id, label: LABELS[id], status, reason };
    if (extra.detail !== undefined) c.detail = extra.detail;
    if (extra.blockedBy !== undefined) c.blockedBy = extra.blockedBy;
    out.set(id, c);
  };
  const pathApi = probes.platform === 'win32' ? path.win32 : path.posix;
  const blocked = (id: DiagnosticId, by: DiagnosticId) => put(id, 'not_applicable', `skipped: ${LABELS[by].toLowerCase()} did not pass`, { blockedBy: by });

  // repo_path — must be absolute, exist, and match the on-disk case exactly (a case-only mismatch
  // breaks worktree paths and string comparisons on case-insensitive filesystems).
  const repoPath = ws.repoPath;
  if (!pathApi.isAbsolute(repoPath)) {
    put('repo_path', 'failed', `"${repoPath}" is a relative path; name the repository's absolute path`);
  } else {
    const real = probes.realPath(repoPath);
    if (real === null) put('repo_path', 'failed', `nothing exists at ${repoPath}`);
    else if (!samePathCase(repoPath, real, probes.platform)) put('repo_path', 'failed', `the configured path differs in case from the disk; use ${real}`, { detail: real });
    else put('repo_path', 'ok', 'exists with the exact on-disk case', { detail: real });
  }
  const repoOk = out.get('repo_path')!.status === 'ok';

  // git / node — on the board server's PATH (where the supervisors normally run)
  for (const tool of ['git', 'node'] as const) {
    const r = await probes.exec(tool, ['--version']);
    if (r.missing) put(tool, 'failed', `${tool} executable not found on PATH`);
    else if (!r.ok) put(tool, 'failed', `\`${tool} --version\` failed`);
    else put(tool, 'ok', `${tool} is available`, { detail: r.stdout.trim() });
  }
  const gitOk = out.get('git')!.status === 'ok';
  const gitBlocker: DiagnosticId | null = !repoOk ? 'repo_path' : !gitOk ? 'git' : null;

  // origin — identity of the remote (bare URL, never its embedded credential)
  let remote: RemoteRef | null = null;
  if (gitBlocker) blocked('origin', gitBlocker);
  else {
    const r = await probes.exec('git', ['remote', 'get-url', 'origin'], repoPath);
    const url = r.ok ? r.stdout.trim() : '';
    if (!url) put('origin', 'failed', 'the repository has no origin remote');
    else {
      const shown = redactUrl(url);
      remote = parseRemoteUrl(url);
      if (!remote) put('origin', 'ok', 'origin is set but its host is not GitHub or Azure DevOps — delivery and host checks do not apply', { detail: shown });
      else put('origin', 'ok', remote.provider === 'github' ? `GitHub ${remote.owner}/${remote.repo}` : `Azure DevOps ${remote.organization}/${remote.project}/${remote.repo}`, { detail: shown });
    }
  }

  // base_ref — the configured base branch must resolve; otherwise detect the default branch
  let baseBranch: string | null = null;
  if (gitBlocker) blocked('base_ref', gitBlocker);
  else if (ws.baseBranch !== null) {
    const b = ws.baseBranch;
    if (isSafeRef(b) && (await resolves(probes, repoPath, `refs/remotes/origin/${b}`) || await resolves(probes, repoPath, `refs/heads/${b}`))) {
      baseBranch = b;
      put('base_ref', 'ok', `configured base branch ${b} resolves`, { detail: b });
    } else put('base_ref', 'failed', `configured base branch ${b} resolves neither as origin/${b} nor as a local branch`);
  } else {
    const head = await probes.exec('git', ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], repoPath);
    const fromHead = head.ok ? head.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : '';
    if (fromHead) {
      baseBranch = fromHead;
      put('base_ref', 'ok', `detected from origin/HEAD (no base branch configured)`, { detail: fromHead });
    } else {
      for (const name of ['main', 'master']) {
        if (await resolves(probes, repoPath, `refs/remotes/origin/${name}`) || await resolves(probes, repoPath, `refs/heads/${name}`)) { baseBranch = name; break; }
      }
      if (baseBranch) put('base_ref', 'ok', `detected ${baseBranch} (origin/HEAD is unset; no base branch configured)`, { detail: baseBranch });
      else put('base_ref', 'failed', 'cannot detect the default branch (no origin/HEAD, main or master); configure a base branch');
    }
  }

  // verify_command — its first token must resolve to an executable
  if (ws.verifyCommand === null) put('verify_command', 'not_applicable', 'no verify command configured');
  else {
    const exe = firstToken(ws.verifyCommand);
    if (!exe) put('verify_command', 'failed', 'the verify command is empty');
    else {
      const isPathLike = /[\\/]/.test(exe);
      if (isPathLike && !pathApi.isAbsolute(exe) && !repoOk) blocked('verify_command', 'repo_path');
      else {
        const found = isPathLike
          ? resolvePathLike(pathApi.resolve(repoPath, exe), probes)
          : findOnPath(exe, probes, pathApi);
        if (found) put('verify_command', 'ok', `\`${exe}\` resolves`, { detail: found });
        else put('verify_command', 'failed', isPathLike ? `\`${exe}\` does not exist relative to the repository` : `\`${exe}\` is not found on PATH`);
      }
    }
  }

  // pat — presence only; the env fallbacks are reported by name and set/unset, never by value
  const provider = remote?.provider ?? null;
  const envNames = provider ? [perWorkspaceEnvVar(BASE_ENV_VAR[provider], ws.name), BASE_ENV_VAR[provider]] : [];
  const envHit = envNames.find((n) => !!probes.env[n]);
  if (ws.hasPat) put('pat', 'ok', 'a workspace PAT is configured');
  else if (!provider) put('pat', 'not_applicable', 'no workspace PAT stored; ambient git credentials apply');
  else put('pat', 'not_applicable', `no workspace PAT stored; falls back to ${envNames.map((n) => `${n} ${probes.env[n] ? 'is set' : '(unset)'}`).join(', then ')}, then ambient git credentials`);

  // host_checks — can the configured credentials read CI checks on the host?
  const credential = pat ?? (envHit ? probes.env[envHit] ?? null : null);
  const credentialName = pat ? 'the workspace PAT' : envHit ?? null;
  if (out.get('origin')!.status !== 'ok') blocked('host_checks', out.get('origin')!.blockedBy ?? 'origin');
  else if (!remote) put('host_checks', 'not_applicable', 'origin is not on GitHub or Azure DevOps', { blockedBy: 'origin' });
  else if (!credential || !credentialName) put('host_checks', 'not_applicable', `no credential configured (workspace PAT, ${envNames.join(' or ')})`, { blockedBy: 'pat' });
  else if (remote.provider === 'github' && !baseBranch) blocked('host_checks', 'base_ref');
  else {
    const e = encodeURIComponent;
    const req = remote.provider === 'github'
      ? {
        url: `https://api.github.com/repos/${e(remote.owner)}/${e(remote.repo)}/commits/${e(baseBranch!)}/check-runs?per_page=1`,
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${credential}`, 'User-Agent': 'agentfactory-diagnose' },
        okStatus: [200], scope: 'Checks / Contents read',
      }
      : {
        url: `https://dev.azure.com/${e(remote.organization)}/${e(remote.project)}/_apis/build/builds?$top=1&api-version=7.1`,
        headers: { Accept: 'application/json', Authorization: `Basic ${Buffer.from(`:${credential}`, 'utf8').toString('base64')}` },
        okStatus: [200], scope: 'Build (Read)',
      };
    const host = remote.provider === 'github' ? 'GitHub' : 'Azure DevOps';
    try {
      const res = await probes.fetch(req.url, { headers: req.headers });
      if (req.okStatus.includes(res.status)) put('host_checks', 'ok', `${credentialName} can read checks on ${host}`);
      else put('host_checks', 'failed', `${host} answered ${res.status} with ${credentialName} — it is invalid, expired, or lacks ${req.scope}`);
    } catch (err) {
      put('host_checks', 'failed', `could not reach ${host}: ${redactSecret((err as Error).message, credential)}`);
    }
  }

  const ids: DiagnosticId[] = ['repo_path', 'git', 'node', 'origin', 'base_ref', 'verify_command', 'pat', 'host_checks'];
  return { workspace: ws.name, repoPath, checks: ids.map((id) => out.get(id)!) };
}

async function resolves(probes: DiagnoseProbes, repoPath: string, ref: string): Promise<boolean> {
  return (await probes.exec('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], repoPath)).ok;
}

/** Same path, same case — except a Windows drive letter, whose case carries no meaning. */
function samePathCase(configured: string, real: string, platform: NodeJS.Platform): boolean {
  const norm = (p: string) => (platform === 'win32' ? p.replace(/^[a-z]:/, (d) => d.toUpperCase()).replace(/[\\/]+$/, '') : p.replace(/\/+$/, ''));
  return norm(configured) === norm(real);
}

/** An origin URL without userinfo (a stale embedded credential must never be reported). */
function redactUrl(url: string): string {
  return bareHttpUrl(url) ?? url.replace(/^(ssh:\/\/)[^@/]+:[^@/]*@/i, '$1');
}
function redactSecret(text: string, secret: string): string {
  return secret ? text.split(secret).join('***') : text;
}

/** The command's executable: the first whitespace-delimited token, honouring simple quotes. */
function firstToken(cmd: string): string {
  const m = /^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(cmd);
  return m ? (m[1] ?? m[2] ?? m[3] ?? '') : '';
}

function resolvePathLike(p: string, probes: DiagnoseProbes): string | null {
  if (probes.fileExists(p)) return p;
  if (probes.platform === 'win32') for (const ext of pathExts(probes)) if (probes.fileExists(p + ext)) return p + ext;
  return null;
}
function pathExts(probes: DiagnoseProbes): string[] {
  return (probes.env.PATHEXT ?? probes.env.Pathext ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map((e) => e.toLowerCase());
}
function findOnPath(exe: string, probes: DiagnoseProbes, pathApi: typeof path.posix): string | null {
  const raw = probes.env.PATH ?? probes.env.Path ?? '';
  const dirs = raw.split(probes.platform === 'win32' ? ';' : ':').filter(Boolean);
  for (const dir of dirs) {
    const hit = resolvePathLike(pathApi.join(dir, exe), probes);
    if (hit) return hit;
  }
  return null;
}

/** The real probes: no shell, bounded time, `GIT_OPTIONAL_LOCKS=0` so a diagnosis never takes a lock. */
export function defaultDiagnoseProbes(): DiagnoseProbes {
  return {
    platform: process.platform,
    env: process.env,
    exec: (file, args, cwd) => new Promise((resolve) => {
      execFile(file, args, { cwd, encoding: 'utf8', timeout: 10_000, windowsHide: true, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }, (err, stdout) => {
        if (!err) return resolve({ ok: true, stdout, missing: false });
        resolve({ ok: false, stdout: '', missing: (err as NodeJS.ErrnoException).code === 'ENOENT' && (cwd === undefined || existsSync(cwd)) });
      });
    }),
    realPath: (p) => {
      try { return realpathSync.native(p); } catch { return null; }
    },
    fileExists: (p) => {
      try { return statSync(p).isFile(); } catch { return false; }
    },
    fetch: async (url, init) => {
      const res = await fetch(url, { headers: init.headers, signal: AbortSignal.timeout(10_000), redirect: 'manual' });
      return { status: res.status };
    },
  };
}
