import { describe, it, expect } from 'vitest';
import { resolveServedWorkspaces } from '../src/workspaceSelection.js';

const ALL = ['agentfactory', 'agent-demo', 'pmd', 'kl-dis'];

describe('resolveServedWorkspaces', () => {
  it('serves every DB workspace when no allowlist is given (opt-out default)', () => {
    expect(resolveServedWorkspaces(ALL)).toEqual(ALL);
    expect(resolveServedWorkspaces(ALL, {})).toEqual(ALL);
    expect(resolveServedWorkspaces(ALL, { workspaces: undefined })).toEqual(ALL);
  });

  it('pins to the explicit allowlist when one is given (opt-in back-compat)', () => {
    expect(resolveServedWorkspaces(ALL, { workspaces: ['pmd'] })).toEqual(['pmd']);
  });

  it('drops excluded slugs from the served-all set', () => {
    expect(resolveServedWorkspaces(ALL, { exclude: ['agent-demo'] })).toEqual([
      'agentfactory',
      'pmd',
      'kl-dis',
    ]);
  });

  it('also applies excludes to an explicit allowlist', () => {
    expect(resolveServedWorkspaces(ALL, { workspaces: ['pmd', 'agent-demo'], exclude: ['agent-demo'] })).toEqual([
      'pmd',
    ]);
  });

  it('picks up a newly-added workspace (the whole point — no config edit needed)', () => {
    const before = resolveServedWorkspaces(['pmd'], { exclude: ['agent-demo'] });
    const after = resolveServedWorkspaces(['pmd', 'nimbus'], { exclude: ['agent-demo'] });
    expect(before).toEqual(['pmd']);
    expect(after).toEqual(['pmd', 'nimbus']);
  });

  it('returns an empty set when everything is excluded', () => {
    expect(resolveServedWorkspaces(['pmd'], { exclude: ['pmd'] })).toEqual([]);
  });
});
