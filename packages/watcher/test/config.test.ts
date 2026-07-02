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
  it('requires db and at least one workspace', () => {
    expect(() => parseConfig({ workspaces: ['a'] })).toThrow();
    expect(() => parseConfig({ db: 'x', workspaces: [] })).toThrow();
  });
  it('rejects unknown provider keys (strict blocks typos)', () => {
    expect(() => parseConfig({ db: 'x', workspaces: ['a'], github: { token: 'inline-secret' } })).toThrow();
  });
  it('loadConfig reads via the injected reader', () => {
    const c = loadConfig('watcher.config.json', () => JSON.stringify({ db: './db', workspaces: ['w'], pollSeconds: 30 }));
    expect(c.pollSeconds).toBe(30);
  });
});
