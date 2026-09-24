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

  it('spawns a merge-conflict repair even when earlier implementation rounds were skip-listed', async () => {
    const core = openCore(':memory:', { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
    core.createWorkspace({ name: 'ws', repoPath: '/repo/ws' });
    const key = seedQueued(core, 'ws', 'Conflicted');
    const { spawn, calls } = makeFakeSpawn();
    const d = new Dispatcher(makeConfig({ maxAttempts: 2 }), makeDeps(core, spawn, { console: makeFakeConsole() }));

    for (let i = 0; i < 2; i++) { // two crashed rounds burn the dispatcher budget
      await d.tick();
      core.claimNextTask({ taskKey: key, claimedBy: calls[i]!.req.env['AGENTFACTORY_WORKER']! });
      await calls[i]!.child.exit(1);
    }
    expect(d.isSkipListed(key)).toBe(true);

    // an operator finishes the work by hand; it is approved, then main moves and the PR conflicts
    core.restartTask(key);
    core.claimNextTask({ taskKey: key, claimedBy: 'interactive' });
    core.submitResult(key, { summary: 'done by hand' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'merge_conflict', detail: 'PR #58 has merge conflicts' });

    await d.tick();
    expect(calls).toHaveLength(3); // the watcher's bounce is new work, not a third retry
    expect(d.isSkipListed(key)).toBe(false);

    // two crashed repair rounds skip-list it again; the watcher's FINAL bounce needs a human
    core.claimNextTask({ taskKey: key, claimedBy: calls[2]!.req.env['AGENTFACTORY_WORKER']! });
    await calls[2]!.child.exit(1);
    await d.tick();
    core.claimNextTask({ taskKey: key, claimedBy: calls[3]!.req.env['AGENTFACTORY_WORKER']! });
    await calls[3]!.child.exit(1);
    expect(d.isSkipListed(key)).toBe(true);
    core.restartTask(key);
    core.claimNextTask({ taskKey: key, claimedBy: 'interactive' });
    core.submitResult(key, { summary: 'fixed by hand' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'merge_conflict', detail: 'conflicts again' });
    expect(core.getTask(key).failure).toMatchObject({ source: 'watcher', skipListed: true });
    await d.tick();
    expect(calls).toHaveLength(4); // no worker for a task the board will not let it claim
  });

  it.each([false, true])('stops an active repair after merge without requeuing it (termination retry: %s)', async (retryTermination) => {
    const core = openCore(':memory:', { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
    core.createWorkspace({ name: 'ws', repoPath: '/repo/ws' });
    const key = seedQueued(core, 'ws', 'Already delivered');
    core.claimNextTask({ taskKey: key, claimedBy: 'original' });
    core.submitResult(key, { summary: 'original fix' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'verify failed' });
    const { spawn, calls } = makeFakeSpawn();
    let failuresLeft = retryTermination ? 1 : 0;
    const d = new Dispatcher(makeConfig(), makeDeps(core, spawn, {
      console: makeFakeConsole(),
      terminateProcessTree: (child, signal) => {
        if (failuresLeft-- > 0) throw new Error('temporary process termination failure');
        child.kill(signal);
      },
    }));
    await d.tick();
    core.claimNextTask({ taskKey: key, claimedBy: calls[0]!.req.env['AGENTFACTORY_WORKER']! });
    core.recordDeliveryCheck(key, { prUrl: 'https://github.com/acme/widgets/pull/42', prId: '#42',
      prState: 'merged', checksState: 'failing', failing: [{ name: 'verify', url: null }] });
    await d.tick();
    if (retryTermination) {
      expect(calls[0]!.child.killed).toBe(false);
      await d.tick();
    }
    expect(calls[0]!.child.killed).toBe(true);
    expect(core.getTask(key).status).toBe('done');
    expect(d.runningCount()).toBe(0);
    await d.tick();
    expect(calls).toHaveLength(1);
    expect(core.getTask(key).activity.filter(a => a.toStatus === 'queued')).toHaveLength(2);
  });
});
