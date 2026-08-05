import { describe, it, expect } from 'vitest';
import { parseConfig, loadConfig } from '../src/config.js';

describe('reviewer config', () => {
  it('applies defaults (codex engine, 60s poll, 20m cap, 120k diff, 2 attempts)', () => {
    const c = parseConfig({ db: './x.db', workspaces: ['ws'] });
    expect(c).toMatchObject({
      engine: 'codex',
      pollSeconds: 60,
      maxConcurrent: 1,
      reviewMinutes: 20,
      maxDiffChars: 120000,
      maxAttempts: 2,
    });
    expect(c.model).toBeUndefined();
  });

  it('requires at least one workspace WHEN the field is present', () => {
    expect(() => parseConfig({ db: './x.db', workspaces: [] })).toThrow();
  });

  it('db/board XOR: accepts board-only, rejects both, rejects neither (#46)', () => {
    expect(parseConfig({ board: { url: 'http://board:8787', tokenEnv: 'AF_REVIEWER' } }).board?.url).toBe('http://board:8787');
    expect(() => parseConfig({ db: './x.db', board: { url: 'http://b' } })).toThrow(/exactly one/);
    expect(() => parseConfig({})).toThrow(/exactly one/);
  });

  it('accepts repoPathOverrides', () => {
    expect(parseConfig({ board: { url: 'http://b' }, repoPathOverrides: { ws: '/clones/ws' } }).repoPathOverrides).toEqual({ ws: '/clones/ws' });
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

  it('visualization defaults to enabled with no engine/model override', () => {
    const c = parseConfig({ db: './x.db' });
    expect(c.visualization).toEqual({ enabled: true });
  });

  it('visualization accepts enabled:false and engine/model overrides', () => {
    const c = parseConfig({ db: './x.db', visualization: { enabled: false } });
    expect(c.visualization.enabled).toBe(false);
    const d = parseConfig({ db: './x.db', visualization: { engine: 'claude', model: 'opus' } });
    expect(d.visualization).toEqual({ enabled: true, engine: 'claude', model: 'opus' });
  });

  it('visualization rejects unknown keys and unknown engines', () => {
    expect(() => parseConfig({ db: './x.db', visualization: { minutes: 5 } })).toThrow();
    expect(() => parseConfig({ db: './x.db', visualization: { engine: 'gpt' } })).toThrow();
  });

  it('loadConfig parses JSON through the injected reader', () => {
    const c = loadConfig('/cfg.json', () => JSON.stringify({ db: './x.db', workspaces: ['ws'] }));
    expect(c.workspaces).toEqual(['ws']);
    expect(c.engine).toBe('codex');
  });
});
