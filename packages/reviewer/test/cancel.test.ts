import { describe, it, expect } from 'vitest';
import type { Core } from '@agentfactory/core';
import { Reviewer } from '../src/reviewer.js';
import { parseConfig } from '../src/config.js';
import { makeCore, seedInReview, aiReviewBody, makeConfig, makeDeps, makeFakeSpawn, makeFakeConsole } from './helpers.js';

const failureNotes = (core: Core, key: string) =>
  core.getTask(key).activity.filter((a) => a.type === 'comment' && a.body.startsWith('failure/v1'));

describe('a human cancels a task under review', () => {
  it('kills the running review next tick without a failure note or a spent attempt', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Cancelled in review', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(makeConfig(), makeDeps(core, spawn, { console: log }));

    await r.tick();
    expect(calls).toHaveLength(1);
    core.updateStatus(key, 'cancelled', 'human');
    await r.tick();

    expect(calls[0]!.child.killed).toBe(true);
    expect(failureNotes(core, key)).toHaveLength(0);
    expect([...log.errors, ...log.warnings]).toEqual([]);
    expect(log.logs.some((l) => l.includes('was cancelled'))).toBe(true);
    expect(core.getRetryBudget(key, 'reviewer:implementation')).toMatchObject({ attemptsUsed: 0 });
    expect(r.isSkipListed(key)).toBe(false);
    await r.tick();
    expect(calls).toHaveLength(1);
  });

  it('kills a consensus round mid-way and never launches its next member', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Cancelled mid-consensus', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    let output = '';
    const config = parseConfig({ db: ':memory:', workspaces: ['ws'], visualization: { enabled: false },
      consensus: { enabled: true, totalMinutes: 30 }, reviewers: [{ engine: 'claude', model: 'fable' }, { engine: 'codex', model: 'astra' }] });
    const r = new Reviewer(config, makeDeps(core, spawn, { console: log, readOutput: () => output,
      computeDiff: async () => ({ baseRef: 'main', baseSha: 'b'.repeat(40), headSha: 'a'.repeat(40), diff: '+bug', commits: 1 }) }));

    await r.tick();
    output = aiReviewBody(1, 'claude');
    calls[0]!.child.emitStdout(output);
    await calls[0]!.child.exit(0); // first member done → the second one starts
    output = '';
    expect(calls).toHaveLength(2);

    core.updateStatus(key, 'cancelled', 'human');
    await r.tick();

    expect(calls[1]!.child.killed).toBe(true);
    expect(calls).toHaveLength(2);
    expect(failureNotes(core, key)).toHaveLength(0);
    expect([...log.errors, ...log.warnings]).toEqual([]);
    expect(log.logs.some((l) => l.includes('was cancelled'))).toBe(true);
    expect(core.getTask(key).aiReview).toBeNull();
  });

  it('kills a running visualization without a failure note', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Cancelled while visualizing', 'implementation');
    const { spawn, calls } = makeFakeSpawn();
    const log = makeFakeConsole();
    const r = new Reviewer(makeConfig({ visualization: { enabled: true } }), makeDeps(core, spawn, { console: log }));

    await r.tick();
    expect(calls[0]!.req.args.some((a) => a.includes('-viz-'))).toBe(true);
    core.updateStatus(key, 'cancelled', 'human');
    await r.tick();

    expect(calls[0]!.child.killed).toBe(true);
    expect(failureNotes(core, key)).toHaveLength(0);
    expect([...log.errors, ...log.warnings]).toEqual([]);
    expect(log.logs.some((l) => l.includes('was cancelled'))).toBe(true);
    expect(core.getTask(key).hasVisualization).toBe(false);
    await r.tick();
    expect(calls).toHaveLength(1);
  });
});
