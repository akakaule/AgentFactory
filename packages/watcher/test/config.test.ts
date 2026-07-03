import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/config.js';

describe('watcher config', () => {
  it('applies defaults', () => {
    const c = parseConfig({ db: './x.db', workspaces: ['default'] });
    expect(c).toMatchObject({
      name: 'watcher',
      pollSeconds: 60,
      postMergeChecks: false,
      maxBackoffSeconds: 900,
      github: { tokenEnv: 'GITHUB_TOKEN', apiBase: 'https://api.github.com' },
      azdo: { patEnv: 'AZDO_PAT', apiVersion: '7.1' },
    });
  });
  it('requires db, and at least one workspace WHEN the field is present', () => {
    expect(() => parseConfig({ workspaces: ['a'] })).toThrow(); // missing db
    expect(() => parseConfig({ db: 'x', workspaces: [] })).toThrow(); // present but empty
  });
  it('allows omitting workspaces (opt-out: serve all) and defaults excludeWorkspaces to []', () => {
    const c = parseConfig({ db: 'x' });
    expect(c.workspaces).toBeUndefined();
    expect(c.excludeWorkspaces).toEqual([]);
  });
  it('accepts an excludeWorkspaces opt-out list', () => {
    expect(parseConfig({ db: 'x', excludeWorkspaces: ['agent-demo'] }).excludeWorkspaces).toEqual(['agent-demo']);
  });
  it('rejects unknown provider keys (strict blocks typos)', () => {
    expect(() => parseConfig({ db: 'x', workspaces: ['a'], github: { token: 'inline-secret' } })).toThrow();
  });
  it('loadConfig reads via the injected reader', () => {
    const c = loadConfig('watcher.config.json', () => JSON.stringify({ db: './db', workspaces: ['w'], pollSeconds: 30 }));
    expect(c.pollSeconds).toBe(30);
  });
});
