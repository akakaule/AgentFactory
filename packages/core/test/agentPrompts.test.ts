import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateWorkspace } from '../src/ops/updateWorkspace.js';
import { listWorkspaces } from '../src/ops/listWorkspaces.js';
import { getGlobalPrompts, setGlobalPrompts, resolveAgentPrompt } from '../src/agentPrompts.js';
import { ValidationError } from '../src/errors.js';

describe('global agent prompts (app_kv)', () => {
  it('starts empty; sets, merges, clears (blank) keys; ignores unknown keys', () => {
    const db = makeTestDb();
    expect(getGlobalPrompts(db)).toEqual({});

    setGlobalPrompts(db, { 'worker.implementation': 'be careful', reviewer: 'be strict' });
    expect(getGlobalPrompts(db)).toEqual({ 'worker.implementation': 'be careful', reviewer: 'be strict' });

    // merge keeps reviewer, a blank value clears worker.implementation, an unknown key is ignored
    setGlobalPrompts(db, { 'worker.implementation': '   ', 'worker.plan': 'plan well', bogus: 'x' });
    expect(getGlobalPrompts(db)).toEqual({ reviewer: 'be strict', 'worker.plan': 'plan well' });
  });
});

describe('workspace prompt overrides + resolveAgentPrompt', () => {
  it('migration #20 adds prompt_overrides; a fresh workspace has {}', () => {
    const db = makeTestDb();
    const cols = (db.prepare("PRAGMA table_info('workspace')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('prompt_overrides');
    expect(createWorkspace(db, { name: 'repo-a', repoPath: '/a' }).promptOverrides).toEqual({});
  });

  it('stores cleaned overrides (blanks dropped), exposes them, and rejects unknown keys', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });

    const updated = updateWorkspace(db, 'repo-a', { promptOverrides: { reviewer: 'ws-strict', 'worker.plan': '   ' } });
    expect(updated.promptOverrides).toEqual({ reviewer: 'ws-strict' }); // blank worker.plan dropped
    expect(listWorkspaces(db).find((w) => w.name === 'repo-a')?.promptOverrides).toEqual({ reviewer: 'ws-strict' });

    expect(() => updateWorkspace(db, 'repo-a', { promptOverrides: { nope: 'x' } })).toThrow(ValidationError);
  });

  it('resolveAgentPrompt precedence: workspace override > global > empty', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });

    expect(resolveAgentPrompt(db, 'reviewer', 'repo-a')).toBe(''); // nothing configured
    setGlobalPrompts(db, { reviewer: 'global-review', 'worker.implementation': 'global-impl' });
    expect(resolveAgentPrompt(db, 'reviewer', 'repo-a')).toBe('global-review'); // global default
    updateWorkspace(db, 'repo-a', { promptOverrides: { reviewer: 'ws-review' } });
    expect(resolveAgentPrompt(db, 'reviewer', 'repo-a')).toBe('ws-review'); // override wins
    expect(resolveAgentPrompt(db, 'worker.implementation', 'repo-a')).toBe('global-impl'); // no override → global
  });

  it('clearing overrides ({}) stores NULL and inherits the global again', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });
    setGlobalPrompts(db, { reviewer: 'global-review' });
    updateWorkspace(db, 'repo-a', { promptOverrides: { reviewer: 'ws-review' } });
    expect(resolveAgentPrompt(db, 'reviewer', 'repo-a')).toBe('ws-review');

    updateWorkspace(db, 'repo-a', { promptOverrides: {} });
    expect(listWorkspaces(db).find((w) => w.name === 'repo-a')?.promptOverrides).toEqual({});
    expect(resolveAgentPrompt(db, 'reviewer', 'repo-a')).toBe('global-review');
  });
});
