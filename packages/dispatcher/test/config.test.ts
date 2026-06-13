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

  it('defaults stageArgs to undefined (no per-stage overrides)', () => {
    const cfg = parseConfig({ db: 'x', workspaces: ['a'] });
    expect(cfg.stageArgs).toBeUndefined();
  });

  it('accepts per-stage claude args keyed by pipeline stage', () => {
    const cfg = parseConfig({
      db: 'x',
      workspaces: ['a'],
      stageArgs: {
        description: ['--model', 'haiku'],
        plan: ['--model', 'sonnet'],
        implementation: ['--model', 'opus'],
      },
    });
    expect(cfg.stageArgs?.description).toEqual(['--model', 'haiku']);
    expect(cfg.stageArgs?.plan).toEqual(['--model', 'sonnet']);
    expect(cfg.stageArgs?.implementation).toEqual(['--model', 'opus']);
  });

  it('accepts a partial stageArgs map (only the stages you want to tier)', () => {
    const cfg = parseConfig({ db: 'x', workspaces: ['a'], stageArgs: { implementation: ['--model', 'opus'] } });
    expect(cfg.stageArgs?.implementation).toEqual(['--model', 'opus']);
    expect(cfg.stageArgs?.description).toBeUndefined();
  });

  it('rejects an unknown stage key in stageArgs', () => {
    expect(() => parseConfig({ db: 'x', workspaces: ['a'], stageArgs: { review: ['--model', 'opus'] } })).toThrow();
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
