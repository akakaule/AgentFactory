import { describe, expect, it } from 'vitest';
import { createCore } from '../src/index.js';
import { makeTestDb } from './helpers.js';

function queued(core: ReturnType<typeof createCore>, title = 'Retry me'): string {
  const task = core.createTask({ title, spec: 'S', acceptanceCriteria: 'A' });
  core.updateStatus(task.key, 'queued', 'human');
  return task.key;
}

describe('durable retry budgets', () => {
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
});
