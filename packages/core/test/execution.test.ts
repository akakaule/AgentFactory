import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { releaseClaim } from '../src/ops/releaseClaim.js';
import { reportProgress } from '../src/ops/agentSession.js';
import { submitResult } from '../src/ops/submitResult.js';
import { addComment } from '../src/ops/addComment.js';
import { attachVisualization } from '../src/ops/visualization.js';
import { reserveExecution, reconcileExecutions } from '../src/ops/execution.js';
import { settleRetry } from '../src/ops/retry.js';
import { InvalidTransitionError } from '../src/errors.js';

function queued(db: ReturnType<typeof makeTestDb>) {
  const task = createTask(db, { title: 'Execution ownership', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, task.key, 'queued', 'human');
  return task;
}

describe('execution ownership', () => {
  it('returns the same execution when a claim response is retried', () => {
    const db = makeTestDb();
    const task = queued(db);

    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    const retry = claimNextTask(db, { claimedBy: 'worker-1' });

    expect(first?.key).toBe(task.key);
    expect(first?.executionId).toBeTruthy();
    expect(retry?.executionId).toBe(first?.executionId);
  });

  it('rejects progress and submit from a released execution after a replacement claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(first?.executionId).toBeTruthy();

    releaseClaim(db, task.key, undefined, first!.executionId);
    const replacement = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(replacement?.executionId).not.toBe(first?.executionId);

    expect(() => reportProgress(db, task.key, { message: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'recovery note', executionId: first!.executionId })).not.toThrow();
  });

  it('rejects unfenced mutations for a supervisor-owned execution', () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(first?.executionId).toBeTruthy();
    releaseClaim(db, task.key, undefined, first!.executionId);
    const claim = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(claim?.executionId).not.toBe(first?.executionId);

    expect(() => reportProgress(db, task.key, { message: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => addComment(db, task.key, { actor: 'agent', body: 'late identity omitted' })).toThrow(InvalidTransitionError);
    expect(() => attachVisualization(db, task.key, { html: '<p>late identity omitted</p>' })).toThrow(InvalidTransitionError);
  });

  it('requires an execution identity from the first supervisor-owned claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    expect(() => submitResult(db, task.key, { summary: 'unfenced' })).toThrow(InvalidTransitionError);
    expect(() => reportProgress(db, task.key, { message: 'unfenced' })).toThrow(InvalidTransitionError);
  });

  it('settles an identical submit retry without mutating the newer task state', () => {
    const db = makeTestDb();
    const task = queued(db);
    const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;

    const first = submitResult(db, task.key, { summary: 'submitted', executionId: claim.executionId });
    const retry = submitResult(db, task.key, { summary: 'submitted again', executionId: claim.executionId });

    expect(first.status).toBe('in_review');
    expect(retry.status).toBe('in_review');
    expect(db.prepare('SELECT COUNT(*) AS count FROM activity WHERE task_id = ? AND type = \'result\'').get(task.id)).toEqual({ count: 1 });
  });

  it('does not resurrect an older active execution after a newer execution settles', () => {
    const db = makeTestDb();
    const task = queued(db);
    const older = reserveExecution(db, task.key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true })!;
    const newer = reserveExecution(db, task.key, { operation: 'worker:implementation', maxAttempts: 2, owner: 'worker-1', startImmediately: true })!;
    expect(newer.id).not.toBe(older.id);
    expect(settleRetry(db, newer.id, { state: 'succeeded' })).toBe(true);

    expect(() => reportProgress(db, task.key, { message: 'old reviewer output', executionId: older.id })).toThrow(InvalidTransitionError);
  });

  it('reconciles a running reservation left queued by a supervisor crash', () => {
    const db = makeTestDb();
    const task = queued(db);
    const execution = reserveExecution(db, task.key, { operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true })!;
    db.prepare("UPDATE task_execution SET reserved_at = '2020-01-01T00:00:00.000Z', heartbeat_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").run(execution.id);

    expect(reconcileExecutions(db, 30_000, () => '2020-01-01T00:01:00.000Z')).toBe(1);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(execution.id)).toEqual({ state: 'cancelled' });
  });

  it('keeps a live pre-claim execution when its heartbeat is fresh', () => {
    const db = makeTestDb();
    const task = queued(db);
    const execution = reserveExecution(db, task.key, {
      operation: 'dispatcher:implementation', maxAttempts: 2, owner: 'default#AF-1', startImmediately: true,
    })!;
    db.prepare("UPDATE task_execution SET reserved_at = '2020-01-01T00:00:00.000Z', heartbeat_at = '2026-09-15T00:00:00.000Z' WHERE id = ?").run(execution.id);

    expect(reconcileExecutions(db, 30_000, () => '2026-09-15T00:00:10.000Z')).toBe(0);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(execution.id)).toEqual({ state: 'running' });
  });
});
