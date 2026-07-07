import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import {
  getSupervisorSettings,
  getAllSupervisorSettings,
  setSupervisorSettings,
  resolveSupervisorConfig,
  applySupervisorSettings,
} from '../src/supervisorSettings.js';
import { ValidationError } from '../src/errors.js';

describe('supervisor settings (app_kv)', () => {
  it('starts empty and round-trips settings per kind, independently', () => {
    const db = makeTestDb();
    expect(getSupervisorSettings(db, 'dispatcher')).toEqual({});

    setSupervisorSettings(db, 'dispatcher', { maxConcurrent: 5, engine: 'codex' });
    expect(getSupervisorSettings(db, 'dispatcher')).toEqual({ maxConcurrent: 5, engine: 'codex' });
    expect(getSupervisorSettings(db, 'reviewer')).toEqual({}); // other kinds untouched
  });

  it('getAll returns all three kinds', () => {
    const db = makeTestDb();
    setSupervisorSettings(db, 'watcher', { postMergeChecks: false, captureBuildErrors: false });
    expect(getAllSupervisorSettings(db)).toEqual({
      dispatcher: {},
      reviewer: {},
      watcher: { postMergeChecks: false, captureBuildErrors: false },
    });
  });

  it('PUT replaces a kind: an omitted field is dropped (inherits file), {} clears all', () => {
    const db = makeTestDb();
    setSupervisorSettings(db, 'dispatcher', { maxConcurrent: 5, engine: 'codex' });
    setSupervisorSettings(db, 'dispatcher', { maxConcurrent: 2 }); // replace — engine dropped
    expect(getSupervisorSettings(db, 'dispatcher')).toEqual({ maxConcurrent: 2 });
    setSupervisorSettings(db, 'dispatcher', {});
    expect(getSupervisorSettings(db, 'dispatcher')).toEqual({});
  });

  it('accepts nested overrides (stageEngines, otel.endpoint)', () => {
    const db = makeTestDb();
    setSupervisorSettings(db, 'dispatcher', { stageEngines: { implementation: 'codex' }, otel: { endpoint: 'http://x' } });
    expect(getSupervisorSettings(db, 'dispatcher')).toEqual({ stageEngines: { implementation: 'codex' }, otel: { endpoint: 'http://x' } });
  });

  it('rejects an unknown field, a secret sub-key, and bad values (ValidationError → HTTP 400)', () => {
    const db = makeTestDb();
    expect(() => setSupervisorSettings(db, 'dispatcher', { db: '/evil.db' })).toThrow(ValidationError); // bootstrap, unknown here
    expect(() => setSupervisorSettings(db, 'dispatcher', { otel: { token: 'x' } })).toThrow(ValidationError); // secret sub-key
    expect(() => setSupervisorSettings(db, 'dispatcher', { maxConcurrent: -1 })).toThrow(ValidationError);
    expect(() => setSupervisorSettings(db, 'reviewer', { engine: 'gpt' })).toThrow(ValidationError);
    expect(() => setSupervisorSettings(db, 'watcher', { pollSeconds: 0 })).toThrow(ValidationError);
  });

  it('resolveSupervisorConfig merges DB over the file config per field, keeping bootstrap from file', () => {
    const db = makeTestDb();
    setSupervisorSettings(db, 'dispatcher', { maxConcurrent: 9, stageEngines: { implementation: 'codex' } });
    const file = { db: '/db', name: 'dispatcher', maxConcurrent: 1, pollSeconds: 15, excludeWorkspaces: ['x'] };
    const merged = resolveSupervisorConfig(db, 'dispatcher', file);
    expect(merged.maxConcurrent).toBe(9); // DB wins
    expect(merged.pollSeconds).toBe(15); // file kept (no override)
    expect(merged.db).toBe('/db'); // bootstrap always from file (never in settings)
    expect(merged.excludeWorkspaces).toEqual(['x']);
    expect((merged as Record<string, unknown>)['stageEngines']).toEqual({ implementation: 'codex' });
  });

  it('empty DB settings ⇒ the file config is returned unchanged (back-compat)', () => {
    const db = makeTestDb();
    const file = { db: '/db', name: 'reviewer', engine: 'codex', pollSeconds: 60 };
    expect(resolveSupervisorConfig(db, 'reviewer', file)).toEqual(file);
  });
});

describe('applySupervisorSettings (merge semantics)', () => {
  it('deep-merges nested objects so an excluded secret sub-key survives', () => {
    const merged = applySupervisorSettings({ otel: { endpoint: 'http://file', token: 'SECRET' } }, { otel: { endpoint: 'http://db' } });
    expect(merged.otel).toEqual({ endpoint: 'http://db', token: 'SECRET' }); // token preserved
  });

  it('replaces arrays whole and keeps db/name (never present in settings)', () => {
    const merged = applySupervisorSettings({ db: '/db', name: 'x', claudeArgs: ['--a', '--b'] }, { claudeArgs: ['--c'] });
    expect(merged.claudeArgs).toEqual(['--c']);
    expect(merged.db).toBe('/db');
    expect(merged.name).toBe('x');
  });
});
