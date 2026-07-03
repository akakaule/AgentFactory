import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/config.js';

describe('reviewer config', () => {
  it('applies defaults (codex engine, 60s poll, 10m cap, 120k diff, 2 attempts)', () => {
    const c = parseConfig({ db: './x.db', workspaces: ['ws'] });
    expect(c).toMatchObject({
      engine: 'codex',
      pollSeconds: 60,
      maxConcurrent: 1,
      reviewMinutes: 10,
      maxDiffChars: 120000,
      maxAttempts: 2,
    });
    expect(c.model).toBeUndefined();
  });

  it('requires at least one workspace WHEN the field is present', () => {
    expect(() => parseConfig({ db: './x.db', workspaces: [] })).toThrow();
  });

  it('allows omitting workspaces (opt-out: watch all) and defaults excludeWorkspaces to []', () => {
    const c = parseConfig({ db: './x.db' });
    expect(c.workspaces).toBeUndefined();
    expect(c.excludeWorkspaces).toEqual([]);
  });

  it('accepts an excludeWorkspaces opt-out list', () => {
    expect(parseConfig({ db: './x.db', excludeWorkspaces: ['agent-demo'] }).excludeWorkspaces).toEqual(['agent-demo']);
  });

  it('rejects an unknown engine', () => {
    expect(() => parseConfig({ db: './x.db', workspaces: ['ws'], engine: 'gpt' })).toThrow();
  });

  it('accepts the claude engine plus a model override', () => {
    const c = parseConfig({ db: './x.db', workspaces: ['ws'], engine: 'claude', model: 'opus' });
    expect(c.engine).toBe('claude');
    expect(c.model).toBe('opus');
  });

  it('loadConfig parses JSON through the injected reader', () => {
    const c = loadConfig('/cfg.json', () => JSON.stringify({ db: './x.db', workspaces: ['ws'] }));
    expect(c.workspaces).toEqual(['ws']);
    expect(c.engine).toBe('codex');
  });
});
