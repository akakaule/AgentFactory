import { describe, it, expect } from 'vitest';
import { parseRemoteUrl, resolveOriginUrl } from '../src/remote.js';

describe('parseRemoteUrl', () => {
  it.each([
    ['https://github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['https://github.com/acme/widgets', { owner: 'acme', repo: 'widgets' }],
    ['git@github.com:acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['ssh://git@github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
    ['https://user@github.com/acme/widgets.git', { owner: 'acme', repo: 'widgets' }],
  ])('GitHub: %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual({ provider: 'github', ...expected });
  });

  it.each([
    ['https://dev.azure.com/acme/Widgets/_git/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    ['https://acme@dev.azure.com/acme/Widgets/_git/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    ['https://acme.visualstudio.com/Widgets/_git/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    ['https://acme.visualstudio.com/DefaultCollection/Widgets/_git/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    ['git@ssh.dev.azure.com:v3/acme/Widgets/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    ['ssh://git@ssh.dev.azure.com:22/v3/acme/Widgets/widgets', { organization: 'acme', project: 'Widgets', repo: 'widgets' }],
    // project names with spaces travel URL-encoded
    ['https://dev.azure.com/acme/My%20Project/_git/widgets', { organization: 'acme', project: 'My Project', repo: 'widgets' }],
  ])('Azure DevOps: %s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual({ provider: 'azdo', ...expected });
  });

  it.each([
    '', ' ', 'not a url',
    'https://gitlab.com/acme/widgets.git',          // unsupported host
    'https://github.com.evil.com/acme/widgets',     // host-anchored: no suffix spoofing
    'https://evil.com/github.com/acme/widgets',     // no path-substring matching
    'https://dev.azure.com/acme/Widgets/widgets',   // ADO without _git
    'https://github.com/acme',                      // missing repo segment
  ])('rejects %s', (url) => {
    expect(parseRemoteUrl(url)).toBeNull();
  });
});

describe('resolveOriginUrl', () => {
  it('returns null for a relative repoPath (cwd-dependent paths never resolve)', () => {
    expect(resolveOriginUrl('.')).toBeNull();
    expect(resolveOriginUrl('some/relative/dir')).toBeNull();
  });
  it('returns null for an absolute path that is not a git repo (never throws)', () => {
    const root = process.platform === 'win32' ? 'C:\\Windows\\Temp\\definitely-not-a-repo-af18' : '/tmp/definitely-not-a-repo-af18';
    expect(resolveOriginUrl(root)).toBeNull();
  });
});
