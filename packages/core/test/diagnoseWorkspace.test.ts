import { describe, it, expect } from 'vitest';
import { diagnoseWorkspace, type DiagnoseProbes, type WorkspaceDiagnosis, type DiagnosticId } from '../src/diagnoseWorkspace.js';
import type { Workspace } from '../src/types.js';

const SECRET = 'ghp_SUPERSECRETTOKEN123';

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 2, name: 'repo-a', repoPath: '/repos/Repo-A', createdAt: '2026-01-01',
  policy: null, verifyCommand: 'npm test', hasPat: true, promptOverrides: {}, adoSync: null,
  baseBranch: null, requiredChecks: null, ciMode: null,
  ...over,
});

interface FakeOpts {
  missing?: string[];          // executables that are not installed
  realPath?: string | null;    // on-disk path (true case) for the repo, null = absent
  origin?: string | null;      // `git remote get-url origin` output, null = no origin
  originHead?: string | null;  // `git symbolic-ref refs/remotes/origin/HEAD`, null = unset
  refs?: string[];             // refs `git rev-parse --verify` resolves
  files?: string[];            // files that exist (PATH lookups)
  status?: number | Error;     // host API answer
  env?: Record<string, string | undefined>;
}

function fakeProbes(o: FakeOpts = {}) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const probes: DiagnoseProbes = {
    platform: 'linux',
    env: { PATH: '/usr/bin', ...o.env },
    async exec(file, args) {
      if ((o.missing ?? []).includes(file)) return { ok: false, stdout: '', missing: true };
      if (args[0] === '--version') return { ok: true, stdout: `${file} version 1.0\n`, missing: false };
      if (file === 'git' && args[0] === 'remote') return o.origin === null ? { ok: false, stdout: '', missing: false } : { ok: true, stdout: `${o.origin ?? 'https://github.com/acme/repo-a.git'}\n`, missing: false };
      if (file === 'git' && args[0] === 'symbolic-ref') {
        const head = o.originHead === undefined ? 'refs/remotes/origin/main' : o.originHead;
        return head === null ? { ok: false, stdout: '', missing: false } : { ok: true, stdout: `${head}\n`, missing: false };
      }
      if (file === 'git' && args[0] === 'rev-parse') {
        const ref = args[args.length - 1]!.replace(/\^\{commit\}$/, '');
        return { ok: (o.refs ?? ['refs/remotes/origin/main']).includes(ref), stdout: '', missing: false };
      }
      return { ok: false, stdout: '', missing: false };
    },
    realPath: () => (o.realPath === undefined ? '/repos/Repo-A' : o.realPath),
    fileExists: (p) => (o.files ?? ['/usr/bin/npm']).includes(p),
    async fetch(url, init) {
      calls.push({ url, headers: init.headers });
      if (o.status instanceof Error) throw o.status;
      return { status: o.status ?? 200 };
    },
  };
  return { probes, calls };
}

const check = (d: WorkspaceDiagnosis, id: DiagnosticId) => d.checks.find((c) => c.id === id)!;
const ALL: DiagnosticId[] = ['repo_path', 'git', 'node', 'origin', 'base_ref', 'verify_command', 'pat', 'host_checks'];

describe('diagnoseWorkspace', () => {
  it('reports every check, each ok on a healthy GitHub workspace, and probes check-runs with the credential', async () => {
    const { probes, calls } = fakeProbes();
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(d.checks.map((c) => c.id)).toEqual(ALL);
    for (const c of d.checks) {
      expect(c.status, `${c.id}: ${c.reason}`).toBe('ok');
      expect(c.reason.length).toBeGreaterThan(0);
    }
    expect(check(d, 'repo_path').detail).toBe('/repos/Repo-A');
    expect(check(d, 'origin').reason).toMatch(/github.*acme\/repo-a/i);
    expect(check(d, 'base_ref').detail).toBe('main');
    expect(check(d, 'base_ref').reason).toMatch(/detected/i);
    expect(check(d, 'verify_command').detail).toBe('/usr/bin/npm');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.github.com/repos/acme/repo-a/commits/main/check-runs?per_page=1');
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it('never includes a secret value — not the PAT, not a credential embedded in the origin URL', async () => {
    const { probes } = fakeProbes({ origin: `https://x-access-token:${SECRET}@github.com/acme/repo-a.git`, status: 401 });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(JSON.stringify(d)).not.toContain(SECRET);
    expect(check(d, 'origin').detail).toBe('https://github.com/acme/repo-a.git');
  });

  it('a host that rejects the credential is a failure naming the status', async () => {
    const { probes } = fakeProbes({ status: 403 });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'host_checks')).toMatchObject({ status: 'failed' });
    expect(check(d, 'host_checks').reason).toMatch(/403/);
  });

  it('a network error reaching the host is a failure, not a crash', async () => {
    const { probes } = fakeProbes({ status: new Error('getaddrinfo ENOTFOUND') });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'host_checks')).toMatchObject({ status: 'failed' });
    expect(check(d, 'host_checks').reason).toMatch(/ENOTFOUND/);
  });

  it('a missing credential is a missing capability (not applicable, blocked by pat), not a failure', async () => {
    const { probes, calls } = fakeProbes();
    const d = await diagnoseWorkspace({ workspace: ws({ hasPat: false }), pat: null }, probes);
    expect(check(d, 'pat')).toMatchObject({ status: 'not_applicable' });
    expect(check(d, 'pat').reason).toMatch(/GITHUB_TOKEN_REPO_A.*GITHUB_TOKEN/);
    expect(check(d, 'host_checks')).toMatchObject({ status: 'not_applicable', blockedBy: 'pat' });
    expect(calls).toHaveLength(0);
  });

  it('falls back to the per-workspace env credential, reporting only its name', async () => {
    const { probes, calls } = fakeProbes({ env: { GITHUB_TOKEN_REPO_A: SECRET } });
    const d = await diagnoseWorkspace({ workspace: ws({ hasPat: false }), pat: null }, probes);
    expect(check(d, 'pat').reason).toMatch(/GITHUB_TOKEN_REPO_A is set/);
    expect(check(d, 'host_checks')).toMatchObject({ status: 'ok' });
    expect(check(d, 'host_checks').reason).toMatch(/GITHUB_TOKEN_REPO_A/);
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${SECRET}`);
    expect(JSON.stringify(d)).not.toContain(SECRET);
  });

  it('probes Azure DevOps builds with Basic PAT auth and treats 203 as an auth failure', async () => {
    const { probes, calls } = fakeProbes({ origin: 'https://dev.azure.com/org/Proj/_git/repo', status: 203 });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(calls[0]!.url).toBe('https://dev.azure.com/org/Proj/_apis/build/builds?$top=1&api-version=7.1');
    expect(calls[0]!.headers.Authorization).toBe(`Basic ${Buffer.from(`:${SECRET}`).toString('base64')}`);
    expect(check(d, 'host_checks')).toMatchObject({ status: 'failed' });
    expect(check(d, 'host_checks').reason).toMatch(/203/);
  });

  it('a missing repo path fails and marks the git-dependent checks not applicable (blocked by repo_path)', async () => {
    const { probes } = fakeProbes({ realPath: null });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'repo_path')).toMatchObject({ status: 'failed' });
    for (const id of ['origin', 'base_ref', 'host_checks'] as const) {
      expect(check(d, id), id).toMatchObject({ status: 'not_applicable', blockedBy: 'repo_path' });
    }
  });

  it('a relative repo path fails', async () => {
    const { probes } = fakeProbes();
    const d = await diagnoseWorkspace({ workspace: ws({ repoPath: '.' }), pat: SECRET }, probes);
    expect(check(d, 'repo_path')).toMatchObject({ status: 'failed' });
    expect(check(d, 'repo_path').reason).toMatch(/absolute/);
  });

  it('a repo path whose case differs from the disk fails and reports the exact on-disk case', async () => {
    const { probes } = fakeProbes({ realPath: '/repos/Repo-A' });
    const d = await diagnoseWorkspace({ workspace: ws({ repoPath: '/repos/repo-a' }), pat: SECRET }, probes);
    expect(check(d, 'repo_path')).toMatchObject({ status: 'failed', detail: '/repos/Repo-A' });
    expect(check(d, 'repo_path').reason).toMatch(/case/);
  });

  it('ignores a drive-letter-only case difference on Windows', async () => {
    const { probes } = fakeProbes({ realPath: 'C:\\Git\\Repo' });
    probes.platform = 'win32';
    const d = await diagnoseWorkspace({ workspace: ws({ repoPath: 'c:\\Git\\Repo' }), pat: SECRET }, probes);
    expect(check(d, 'repo_path')).toMatchObject({ status: 'ok' });
  });

  it('git not installed fails git and blocks the checks that need it', async () => {
    const { probes } = fakeProbes({ missing: ['git'] });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'git')).toMatchObject({ status: 'failed' });
    expect(check(d, 'origin')).toMatchObject({ status: 'not_applicable', blockedBy: 'git' });
    expect(check(d, 'base_ref')).toMatchObject({ status: 'not_applicable', blockedBy: 'git' });
  });

  it('node not installed fails node', async () => {
    const { probes } = fakeProbes({ missing: ['node'] });
    expect(check(await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes), 'node')).toMatchObject({ status: 'failed' });
  });

  it('no origin fails origin and blocks the host check', async () => {
    const { probes } = fakeProbes({ origin: null });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'origin')).toMatchObject({ status: 'failed' });
    expect(check(d, 'host_checks')).toMatchObject({ status: 'not_applicable', blockedBy: 'origin' });
  });

  it('an unrecognized git host makes the host check not applicable', async () => {
    const { probes } = fakeProbes({ origin: 'https://gitlab.com/acme/repo-a.git' });
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, probes);
    expect(check(d, 'origin')).toMatchObject({ status: 'ok' });
    expect(check(d, 'host_checks')).toMatchObject({ status: 'not_applicable', blockedBy: 'origin' });
  });

  it('a configured base branch must resolve; it is reported as configured', async () => {
    const ok = await diagnoseWorkspace({ workspace: ws({ baseBranch: 'develop' }), pat: SECRET }, fakeProbes({ refs: ['refs/remotes/origin/develop'] }).probes);
    expect(check(ok, 'base_ref')).toMatchObject({ status: 'ok', detail: 'develop' });
    expect(check(ok, 'base_ref').reason).toMatch(/configured/);
    const bad = await diagnoseWorkspace({ workspace: ws({ baseBranch: 'develop' }), pat: SECRET }, fakeProbes().probes);
    expect(check(bad, 'base_ref')).toMatchObject({ status: 'failed' });
    expect(check(bad, 'host_checks')).toMatchObject({ status: 'not_applicable', blockedBy: 'base_ref' });
  });

  it('detects main/master when origin/HEAD is unset, and fails when nothing resolves', async () => {
    const d = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, fakeProbes({ originHead: null, refs: ['refs/remotes/origin/master'] }).probes);
    expect(check(d, 'base_ref')).toMatchObject({ status: 'ok', detail: 'master' });
    const none = await diagnoseWorkspace({ workspace: ws(), pat: SECRET }, fakeProbes({ originHead: null, refs: [] }).probes);
    expect(check(none, 'base_ref')).toMatchObject({ status: 'failed' });
  });

  it('verify command: not applicable when unset, failed when its executable does not resolve', async () => {
    const unset = await diagnoseWorkspace({ workspace: ws({ verifyCommand: null }), pat: SECRET }, fakeProbes().probes);
    expect(check(unset, 'verify_command')).toMatchObject({ status: 'not_applicable' });
    const missing = await diagnoseWorkspace({ workspace: ws({ verifyCommand: 'pnpm test' }), pat: SECRET }, fakeProbes().probes);
    expect(check(missing, 'verify_command')).toMatchObject({ status: 'failed' });
    expect(check(missing, 'verify_command').reason).toMatch(/pnpm/);
  });

  it('verify command: resolves a Windows PATHEXT executable and a repo-relative script', async () => {
    const { probes } = fakeProbes({ files: ['C:\\node\\npm.cmd', '/repos/Repo-A/scripts/verify.sh'], env: { PATH: 'C:\\node', PATHEXT: '.COM;.EXE;.CMD' } });
    probes.platform = 'win32';
    const win = await diagnoseWorkspace({ workspace: ws({ repoPath: '/repos/Repo-A' }), pat: SECRET }, probes);
    expect(check(win, 'verify_command')).toMatchObject({ status: 'ok', detail: 'C:\\node\\npm.cmd' });
    probes.platform = 'linux';
    const rel = await diagnoseWorkspace({ workspace: ws({ verifyCommand: './scripts/verify.sh --all' }), pat: SECRET }, probes);
    expect(check(rel, 'verify_command')).toMatchObject({ status: 'ok' });
  });
});
