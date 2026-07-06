import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateWorkspace } from '../src/ops/updateWorkspace.js';
import { resolveGitAuth, gitAuthConfigPairs, bareHttpUrl } from '../src/gitAuth.js';

const ADO = 'https://dev.azure.com/Org/Proj/_git/Repo';
const ADO_WITH_PAT = 'https://oldexpiredpat@dev.azure.com/Org/Proj/_git/Repo';
const GH = 'https://github.com/owner/repo';

/** The credential a produced `Authorization: Basic <b64>` decodes to (`user:pass`). */
function decodeBasic(configValue: string): string {
  const b64 = configValue.replace(/^Authorization: Basic /, '');
  return Buffer.from(b64, 'base64').toString('utf8');
}

describe('resolveGitAuth — precedence: stored PAT > per-ws env > base env > null', () => {
  it('returns null when no PAT is stored and no env var is set', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'ado', repoPath: '/x' });
    expect(resolveGitAuth(db, 'ado', { env: {}, resolveOrigin: () => ADO })).toBeNull();
  });

  it('prefers the stored PAT and strips the (stale) userinfo from the origin — ADO Basic ":pat"', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'ado', repoPath: '/x' });
    updateWorkspace(db, 'ado', { pat: 'stored-pat' });
    // even with both env vars present, the stored PAT wins; the embedded-URL credential is dropped.
    const env = { AZDO_PAT: 'base-pat', AZDO_PAT_ADO: 'ws-pat' };
    const auth = resolveGitAuth(db, 'ado', { env, resolveOrigin: () => ADO_WITH_PAT })!;
    expect(auth.provider).toBe('azdo');
    expect(auth.remoteUrl).toBe(ADO); // userinfo stripped -> bare, authoritative for the header scope
    expect(auth.originUrl).toBe(ADO_WITH_PAT); // the raw origin, kept for the insteadOf rewrite
    expect(auth.configKey).toBe(`http.${ADO}.extraheader`);
    expect(decodeBasic(auth.configValue)).toBe(':stored-pat');
  });

  it('falls back to the per-workspace env var, then the shared base var', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'ado', repoPath: '/x' });
    const wsFirst = resolveGitAuth(db, 'ado', { env: { AZDO_PAT: 'base', AZDO_PAT_ADO: 'ws' }, resolveOrigin: () => ADO })!;
    expect(decodeBasic(wsFirst.configValue)).toBe(':ws');
    const baseOnly = resolveGitAuth(db, 'ado', { env: { AZDO_PAT: 'base' }, resolveOrigin: () => ADO })!;
    expect(decodeBasic(baseOnly.configValue)).toBe(':base');
  });

  it('GitHub uses GITHUB_TOKEN and the x-access-token Basic form', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'gh', repoPath: '/x' });
    updateWorkspace(db, 'gh', { pat: 'ghp_xxx' });
    const auth = resolveGitAuth(db, 'gh', { env: {}, resolveOrigin: () => GH })!;
    expect(auth.provider).toBe('github');
    expect(auth.configKey).toBe(`http.${GH}.extraheader`);
    expect(decodeBasic(auth.configValue)).toBe('x-access-token:ghp_xxx');
  });

  it('returns null for ssh origins (header auth n/a) and unrecognized hosts', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'w', repoPath: '/x' });
    updateWorkspace(db, 'w', { pat: 'x' });
    expect(resolveGitAuth(db, 'w', { env: {}, resolveOrigin: () => 'git@github.com:o/r.git' })).toBeNull();
    expect(resolveGitAuth(db, 'w', { env: {}, resolveOrigin: () => 'https://gitlab.example.com/o/r' })).toBeNull();
  });

  it('returns null when the workspace has no resolvable origin', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'w', repoPath: '/x' });
    updateWorkspace(db, 'w', { pat: 'x' });
    expect(resolveGitAuth(db, 'w', { env: {}, resolveOrigin: () => null })).toBeNull();
  });
});

describe('gitAuthConfigPairs', () => {
  const base = { provider: 'azdo' as const, remoteUrl: ADO, configKey: `http.${ADO}.extraheader`, configValue: 'Authorization: Basic Zm9v==' };

  it('emits only the extraheader when the origin is already bare', () => {
    const pairs = gitAuthConfigPairs({ ...base, originUrl: ADO });
    expect(pairs).toEqual([[`http.${ADO}.extraheader`, 'Authorization: Basic Zm9v==']]);
  });

  it('adds a url.<bare>.insteadOf rewrite when the origin embeds a credential', () => {
    const pairs = gitAuthConfigPairs({ ...base, originUrl: ADO_WITH_PAT });
    expect(pairs).toEqual([
      [`http.${ADO}.extraheader`, 'Authorization: Basic Zm9v=='],
      [`url.${ADO}.insteadOf`, ADO_WITH_PAT],
    ]);
  });
});

describe('bareHttpUrl', () => {
  it('strips userinfo from http(s) urls and returns null for non-http (ssh)', () => {
    expect(bareHttpUrl('https://tok@dev.azure.com/o/p/_git/r')).toBe('https://dev.azure.com/o/p/_git/r');
    expect(bareHttpUrl('https://user:pass@github.com/o/r')).toBe('https://github.com/o/r');
    expect(bareHttpUrl('https://github.com/o/r')).toBe('https://github.com/o/r');
    expect(bareHttpUrl('git@github.com:o/r.git')).toBeNull();
  });
});
