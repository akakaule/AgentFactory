import { describe, it, expect } from 'vitest';
import { createCore, openCore, openDb, runMigrations } from '@agentfactory/core';
import { Dispatcher } from '../src/dispatcher.js';
import { makeConfig, makeDeps, makeFakeConsole, makeFakeSpawn, seedQueued } from './helpers.js';

describe('merged delivery workers', () => {
  it('reconciles a legacy queued merge before spawning and allows an explicit reopen', async () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const core = createCore(db, { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
    core.createWorkspace({ name: 'ws', repoPath: '/repo/ws' });
    const key = seedQueued(core, 'ws', 'Already merged');
    core.claimNextTask({ taskKey: key });
    core.submitResult(key, { summary: 'original fix' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'verify failed' });
    db.prepare("UPDATE task_delivery SET pr_state='merged', checks_state='failing', pr_url='https://github.com/acme/widgets/pull/42', checked_at='2026-09-14T12:00:00Z'").run();
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await d.tick();
    expect(core.getTask(key).status).toBe('done');
    expect(calls).toHaveLength(0);
    core.updateStatus(key, 'queued', 'human');
    await d.tick();
    expect(calls).toHaveLength(1); // explicit reopen remains work
  });

  it('stops an active repair after merge completion without requeuing it', async () => {
    const core = openCore(':memory:', { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
    core.createWorkspace({ name: 'ws', repoPath: '/repo/ws' });
    const key = seedQueued(core, 'ws', 'Already delivered');
    core.claimNextTask({ taskKey: key, claimedBy: 'original' });
    core.submitResult(key, { summary: 'original fix' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'verify failed' });
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, { console: makeFakeConsole() }));
    await d.tick();
    core.claimNextTask({ taskKey: key, claimedBy: calls[0]!.req.env['AGENTFACTORY_WORKER']! });
    core.recordDeliveryCheck(key, { prUrl: 'https://github.com/acme/widgets/pull/42', prId: '#42',
      prState: 'merged', checksState: 'failing', failing: [{ name: 'verify', url: null }] });
    await d.tick();
    expect(calls[0]!.child.killed).toBe(true);
    expect(core.getTask(key).status).toBe('done');
    expect(d.runningCount()).toBe(0);
    await d.tick();
    expect(calls).toHaveLength(1);
    expect(core.getTask(key).activity.filter(a => a.toStatus === 'queued')).toHaveLength(2);
  });
});
