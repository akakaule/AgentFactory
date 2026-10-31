import { describe, it, expect, vi } from 'vitest';
import { probeCredential, parseGithubExpiry, type ProbeRun, type ProbeFetch } from '../src/probeCredential.js';
import type { GitAuth } from '../src/gitAuth.js';

const SECRET = 'Authorization: Basic OnN1cGVyc2VjcmV0';
const azdo: GitAuth = {
  provider: 'azdo', remoteUrl: 'https://dev.azure.com/org/proj/_git/repo', originUrl: 'https://dev.azure.com/org/proj/_git/repo',
  configKey: 'http.https://dev.azure.com/org/proj/_git/repo.extraheader', configValue: SECRET,
};
const github: GitAuth = {
  provider: 'github', remoteUrl: 'https://github.com/acme/widgets.git', originUrl: 'https://github.com/acme/widgets.git',
  configKey: 'http.https://github.com/acme/widgets.git.extraheader', configValue: SECRET,
};
const okRun: ProbeRun = async () => ({ ok: true, stderr: '' });
const failRun = (stderr: string, timedOut = false): ProbeRun => async () => ({ ok: false, stderr, timedOut });
const headers = (h: Record<string, string>) => ({ get: (name: string) => h[name.toLowerCase()] ?? null });

describe('probeCredential', () => {
  it('lists remote heads with the managed header only, never a credential helper or prompt', async () => {
    const run = vi.fn(okRun);
    const result = await probeCredential(azdo, { run, fetch: vi.fn() });

    expect(result).toEqual({ status: 'ok', error: null, expiresAt: null });
    const [args, env] = run.mock.calls[0]!;
    expect(args).toEqual(['-c', 'credential.helper=', 'ls-remote', '--heads', azdo.remoteUrl]);
    expect(env.GIT_TERMINAL_PROMPT).toBe('0');
    expect(env.GCM_INTERACTIVE).toBe('never');
    const n = Number(env.GIT_CONFIG_COUNT);
    const pairs = Array.from({ length: n }, (_, i) => [env[`GIT_CONFIG_KEY_${i}`], env[`GIT_CONFIG_VALUE_${i}`]]);
    expect(pairs.slice(-2)).toEqual([[azdo.configKey, ''], [azdo.configKey, SECRET]]);
  });

  it('reads an authentication failure as failing, with the secret redacted', async () => {
    const result = await probeCredential(azdo, {
      run: failRun(`remote: TF401019\nfatal: Authentication failed for '${azdo.remoteUrl}/' (${SECRET})`), fetch: vi.fn(),
    });
    expect(result.status).toBe('failing');
    expect(result.error).toContain('Authentication failed');
    expect(result.error).not.toContain('OnN1cGVyc2VjcmV0');
  });

  it.each([
    ['fatal: could not read Username for \'https://github.com\': terminal prompts disabled'],
    ['remote: Write access to repository not granted.\nfatal: unable to access: The requested URL returned error: 403'],
    ['fatal: unable to access \'https://dev.azure.com/x/\': The requested URL returned error: 401'],
  ])('reads %s as failing', async (stderr) => {
    expect((await probeCredential(azdo, { run: failRun(stderr), fetch: vi.fn() })).status).toBe('failing');
  });

  it('reads network trouble and timeouts as unreachable, not as a bad credential', async () => {
    expect(await probeCredential(azdo, { run: failRun('fatal: unable to access: Could not resolve host: dev.azure.com'), fetch: vi.fn() }))
      .toMatchObject({ status: 'unreachable' });
    expect(await probeCredential(azdo, { run: failRun('', true), fetch: vi.fn() }))
      .toMatchObject({ status: 'unreachable', error: 'git ls-remote timed out' });
  });

  it('reads a GitHub token expiry from the API with the same header, and skips it for Azure DevOps', async () => {
    const fetch: ProbeFetch = vi.fn(async () => ({ ok: true, status: 200, headers: headers({ 'github-authentication-token-expiration': '2026-11-27 12:00:00 UTC' }) }));
    expect(await probeCredential(github, { run: okRun, fetch })).toEqual({ status: 'ok', error: null, expiresAt: '2026-11-27T12:00:00.000Z' });
    expect(fetch).toHaveBeenCalledWith('https://api.github.com/repos/acme/widgets', expect.objectContaining({
      headers: expect.objectContaining({ Authorization: 'Basic OnN1cGVyc2VjcmV0' }),
    }));

    const azdoFetch = vi.fn();
    await probeCredential(azdo, { run: okRun, fetch: azdoFetch });
    expect(azdoFetch).not.toHaveBeenCalled();
  });

  it('keeps a working credential ok when the expiry lookup fails or has no header', async () => {
    expect(await probeCredential(github, { run: okRun, fetch: async () => { throw new Error('offline'); } }))
      .toEqual({ status: 'ok', error: null, expiresAt: null });
    expect(await probeCredential(github, { run: okRun, fetch: async () => ({ ok: true, status: 200, headers: headers({}) }) }))
      .toEqual({ status: 'ok', error: null, expiresAt: null });
  });

  it('does not ask GitHub for an expiry when git already rejected the credential', async () => {
    const fetch = vi.fn();
    await probeCredential(github, { run: failRun('fatal: Authentication failed'), fetch });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('parseGithubExpiry', () => {
  it('parses the UTC and offset forms GitHub sends, null otherwise', () => {
    expect(parseGithubExpiry('2026-11-27 12:00:00 UTC')).toBe('2026-11-27T12:00:00.000Z');
    expect(parseGithubExpiry('2026-11-27 12:00:00 +0100')).toBe('2026-11-27T11:00:00.000Z');
    expect(parseGithubExpiry(null)).toBeNull();
    expect(parseGithubExpiry('soon')).toBeNull();
  });
});
