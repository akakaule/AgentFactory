import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/config.js';

describe('config', () => {
  it('applies defaults for everything but db + workspaces', () => {
    const cfg = parseConfig({ db: './af.db', workspaces: ['agentfactory'] });
    expect(cfg).toMatchObject({
      db: './af.db',
      workspaces: ['agentfactory'],
      maxConcurrent: 1,
      pollSeconds: 15,
      permissionMode: 'acceptEdits',
      claudeArgs: [],
      maxSessionMinutes: 60,
      maxAttempts: 2,
    });
  });

  it('honours explicit overrides', () => {
    const cfg = parseConfig({
      db: ':memory:',
      workspaces: ['a', 'b'],
      maxConcurrent: 3,
      pollSeconds: 5,
      permissionMode: 'bypassPermissions',
      claudeArgs: ['--verbose'],
      maxSessionMinutes: 30,
      maxAttempts: 4,
    });
    expect(cfg.maxConcurrent).toBe(3);
    expect(cfg.permissionMode).toBe('bypassPermissions');
    expect(cfg.claudeArgs).toEqual(['--verbose']);
    expect(cfg.maxAttempts).toBe(4);
  });

  it('requires at least one workspace', () => {
    expect(() => parseConfig({ db: 'x', workspaces: [] })).toThrow();
  });

  it('rejects an unknown permission mode', () => {
    expect(() => parseConfig({ db: 'x', workspaces: ['a'], permissionMode: 'yolo' })).toThrow();
  });

  it('rejects a missing db', () => {
    expect(() => parseConfig({ workspaces: ['a'] })).toThrow();
  });

  it('loadConfig reads + parses via the injected reader', () => {
    const cfg = loadConfig('/cfg.json', () => JSON.stringify({ db: './af.db', workspaces: ['ws'], maxConcurrent: 2 }));
    expect(cfg.db).toBe('./af.db');
    expect(cfg.maxConcurrent).toBe(2);
    expect(cfg.permissionMode).toBe('acceptEdits');
  });
});
