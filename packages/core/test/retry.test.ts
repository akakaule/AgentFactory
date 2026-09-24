import { describe, expect, it } from 'vitest';
import { createCore } from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { reconcileAbandonedRetryReservations } from '../src/ops/retry.js';

function queued(core: ReturnType<typeof createCore>, title = 'Retry me'): string {
  const task = core.createTask({ title, spec: 'S', acceptanceCriteria: 'A' });
  core.updateStatus(task.key, 'queued', 'human');
  return task.key;
}

describe('durable retry budgets', () => {
  it('a human re-queue of a blocked task gives the worker a fresh budget; releasing a claim does not', () => {
    const core = createCore(makeTestDb());
    const key = queued(core);
    const op = { operation: 'dispatcher:implementation', maxAttempts: 2 } as const;
    for (let i = 0; i < 2; i++) { // two worker rounds that each ended blocked
      const r = core.reserveRetry(key, op)!;
      core.claimNextTask({ taskKey: key, claimedBy: `w${i}` });
      core.updateStatus(key, 'blocked', 'agent', undefined, null, 'needs a human');
      core.settleRetry(r.id, { state: 'succeeded', reason: 'task advanced to blocked' });
      if (i === 0) core.updateStatus(key, 'queued', 'human');
    }
    core.updateStatus(key, 'queued', 'human'); // the human unblocked it: new work
    expect(core.reserveRetry(key, op)).toMatchObject({ generation: 3, attempt: 1 });

    core.claimNextTask({ taskKey: key, claimedBy: 'w9' });
    core.updateStatus(key, 'queued', 'human'); // releasing a stranded claim is still a retry
    expect(core.getRetryBudget(key, 'dispatcher:implementation')).toMatchObject({ generation: 3, attemptsUsed: 1 });
  });

  it('persists spent attempts when a new core/supervisor instance is created', () => {
    const db = makeTestDb();
    const first = createCore(db);
    const key = queued(first);
    const attempt1 = first.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 });
    expect(attempt1?.attempt).toBe(1);
    first.settleRetry(attempt1!.id, { state: 'failed', reason: 'crash' });

    const second = createCore(db);
    const attempt2 = second.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 });
    expect(attempt2?.attempt).toBe(2);
    second.settleRetry(attempt2!.id, { state: 'failed', reason: 'crash' });

    const reconstructed = createCore(db);
    expect(reconstructed.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 })).toBeNull();
    expect(reconstructed.getRetryBudget(key, 'dispatcher:implementation')).toMatchObject({
      generation: 1, attemptsUsed: 2, remaining: 0, exhausted: true,
    });
  });

  it('atomically prevents two reservations from spending one remaining slot', () => {
    const core = createCore(makeTestDb());
    const key = queued(core);
    expect(core.reserveRetry(key, { operation: 'reviewer:implementation', maxAttempts: 1 })).not.toBeNull();
    expect(core.reserveRetry(key, { operation: 'reviewer:implementation', maxAttempts: 1 })).toBeNull();
  });

  it('keeps stage budgets independent and restart opens only the owning scope', () => {
    const core = createCore(makeTestDb());
    const key = queued(core);
    const worker = core.reserveRetry(key, { operation: 'dispatcher:description', maxAttempts: 1 })!;
    core.settleRetry(worker.id, { state: 'failed' });
    const review = core.reserveRetry(key, { operation: 'reviewer:description', maxAttempts: 1 })!;
    core.settleRetry(review.id, { state: 'failed' });

    core.resetRetryBudget(key, 'dispatcher:description', 1, 'operator restart');
    expect(core.getRetryBudget(key, 'dispatcher:description')).toMatchObject({ generation: 2, attemptsUsed: 0 });
    expect(core.getRetryBudget(key, 'reviewer:description')).toMatchObject({ generation: 1, attemptsUsed: 1, exhausted: true });
  });

  it('starts a fresh review budget for a new implementation submission', () => {
    const core = createCore(makeTestDb());
    const key = queued(core);
    core.claimNextTask({ claimedBy: 'worker-1' });
    core.submitResult(key, { summary: 'first submission' });

    const firstReview = core.reserveRetry(key, { operation: 'reviewer:implementation', maxAttempts: 1 })!;
    core.settleRetry(firstReview.id, { state: 'succeeded' });
    core.reviewRequestChanges(key, { feedback: 'please revise' });
    core.claimNextTask({ claimedBy: 'worker-2' });
    core.submitResult(key, { summary: 'second submission' });

    expect(core.reserveRetry(key, { operation: 'reviewer:implementation', maxAttempts: 1 })).toMatchObject({
      attempt: 1, generation: 2,
    });
  });

  it('does not collide when a cancelled reservation precedes a live reservation', () => {
    const core = createCore(makeTestDb());
    const key = queued(core);
    const first = core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 3 })!;
    const second = core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 3 })!;
    core.settleRetry(first.id, { state: 'cancelled' });

    expect(core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 3 })).toMatchObject({
      attempt: 3, generation: 1,
    });
    expect(second.attempt).toBe(2);
  });

  it('refunds reservations that stayed pre-launch beyond the grace period', () => {
    const db = makeTestDb();
    const core = createCore(db);
    const key = queued(core);
    const first = core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 1 });
    expect(first).not.toBeNull();

    expect(reconcileAbandonedRetryReservations(db, 0, () => new Date(Date.now() + 1).toISOString())).toBe(1);
    expect(core.getRetryBudget(key, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 0, exhausted: false });
    expect(core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 1 })).toMatchObject({ attempt: 1 });
  });

  it('moves a predicted reservation to the actually claimed task atomically', () => {
    const core = createCore(makeTestDb());
    const predicted = queued(core, 'predicted');
    const actual = queued(core, 'actual');
    const reservation = core.reserveRetry(predicted, { operation: 'dispatcher:implementation', maxAttempts: 2 })!;

    const moved = core.reconcileRetry(reservation.id, {
      actualKey: actual, operation: 'dispatcher:implementation', maxAttempts: 2,
    });

    expect(moved).toMatchObject({ id: reservation.id, taskKey: actual, attempt: 1 });
    expect(core.getRetryBudget(predicted, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 0 });
    expect(core.getRetryBudget(actual, 'dispatcher:implementation')).toMatchObject({ attemptsUsed: 1 });
  });
});
