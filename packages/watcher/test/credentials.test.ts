import { describe, it, expect } from 'vitest';
import { perWorkspaceEnvVar, resolveCredential } from '../src/credentials.js';

describe('perWorkspaceEnvVar', () => {
  it('appends the sanitized, uppercased workspace slug to the base var', () => {
    expect(perWorkspaceEnvVar('AZDO_PAT', 'kl-disconfiguration')).toBe('AZDO_PAT_KL_DISCONFIGURATION');
    expect(perWorkspaceEnvVar('GITHUB_TOKEN', 'agentfactory')).toBe('GITHUB_TOKEN_AGENTFACTORY');
  });

  it('collapses runs of non-alphanumerics to a single underscore, no leading/trailing', () => {
    expect(perWorkspaceEnvVar('AZDO_PAT', 'kl.ce-adapter')).toBe('AZDO_PAT_KL_CE_ADAPTER');
    expect(perWorkspaceEnvVar('AZDO_PAT', '-weird--slug-')).toBe('AZDO_PAT_WEIRD_SLUG');
  });
});

describe('resolveCredential', () => {
  it('prefers the per-workspace var over the shared base var', () => {
    const env = { AZDO_PAT: 'shared', AZDO_PAT_KL_DIS: 'per-ws' };
    expect(resolveCredential(env, 'AZDO_PAT', 'kl-dis').token).toBe('per-ws');
  });

  it('falls back to the shared base var when no per-workspace var is set', () => {
    const env = { AZDO_PAT: 'shared' };
    expect(resolveCredential(env, 'AZDO_PAT', 'kl-dis').token).toBe('shared');
  });

  it('returns null when neither is set (provider then sends no auth header)', () => {
    const r = resolveCredential({}, 'AZDO_PAT', 'kl-dis');
    expect(r.token).toBeNull();
    expect(r.envVar).toBe('AZDO_PAT_KL_DIS'); // still reports what to set
    expect(r.base).toBe('AZDO_PAT');
  });

  it('prefers the stored (UI-set) PAT over both env vars', () => {
    const env = { AZDO_PAT: 'shared', AZDO_PAT_KL_DIS: 'per-ws' };
    expect(resolveCredential(env, 'AZDO_PAT', 'kl-dis', 'stored-pat').token).toBe('stored-pat');
  });

  it('falls back to the env chain when no PAT is stored (null / undefined)', () => {
    const env = { AZDO_PAT_KL_DIS: 'per-ws' };
    expect(resolveCredential(env, 'AZDO_PAT', 'kl-dis', null).token).toBe('per-ws');
    expect(resolveCredential(env, 'AZDO_PAT', 'kl-dis', undefined).token).toBe('per-ws');
  });
});
