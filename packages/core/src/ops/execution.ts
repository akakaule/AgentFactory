import type { DB } from '../db.js';
import type { Execution, RetryOperation, Status } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { createExecution, abandonedExecutionIds, currentExecution, executionForTask, settleExecution, touchExecution as touchExecutionRow } from '../repo/execution.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow } from '../repo/retry.js';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export interface ReserveExecutionInput { operation: RetryOperation; maxAttempts: number; owner?: string | null | undefined; startImmediately?: boolean | undefined; }

/**
 * A live execution whose heartbeat is younger than this still owns its task, so a second
 * reservation is refused instead of superseding it. Supervisors refresh their executions every
 * tick; only an owner that crashed (or stalled for minutes) ages past it.
 */
export const EXECUTION_LEASE_MS = 5 * 60_000;

/** The task status an operation acts on; undefined for an operation without a lifecycle rule. */
function operationStatus(operation: RetryOperation): Status | undefined {
  if (operation.startsWith('dispatcher:') || operation.startsWith('worker:')) return 'queued';
  if (operation === 'reviewer:feedback-eval') return 'delivering';
  if (operation.startsWith('reviewer:') || operation.startsWith('visualization:')) return 'in_review';
  return undefined;
}

/**
 * Reserve the next attempt of an operation and record it as the task's execution, or null once
 * the operation's budget is spent. Throws InvalidTransitionError — consuming no budget — when the
 * task is not in the status the operation acts on, or another supervisor's execution still owns
 * that phase of the task (a racing supervisor skips the task for now; it is not exhausted).
 */
export function reserveExecution(db: DB, key: string, input: ReserveExecutionInput, now: () => string = nowIso): Execution | null {
  if (!input.operation.trim()) throw new ValidationError('execution operation is required');
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new ValidationError('maxAttempts must be a positive integer');
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    const ts = now();
    const required = operationStatus(input.operation);
    if (required !== undefined && row.status !== required)
      throw new InvalidTransitionError(`${key} is ${row.status}; ${input.operation} acts on ${required} tasks`);
    // A live execution from an earlier phase (e.g. the worker's, before review) no longer owns
    // the task; one serving the current phase does until its heartbeat outlives the lease.
    const live = currentExecution(db, row.id);
    if (live && operationStatus(live.operation) === row.status) {
      const lastSeen = Date.parse(live.heartbeat_at ?? live.reserved_at);
      if (Date.parse(ts) - lastSeen < EXECUTION_LEASE_MS)
        throw new InvalidTransitionError(`${key} already has a live execution (${live.operation})`);
      if (live.retry_id) settleRetryRow(db, live.retry_id, 'cancelled', ts, 'execution superseded after its lease expired');
      settleExecution(db, live.id, 'cancelled', ts, 'execution superseded after its lease expired');
    }
    const retry = reserveRetryRow(db, row.id, key, { operation: input.operation, maxAttempts: input.maxAttempts }, ts);
    if (!retry) return null;
    return createExecution(db, {
      id: retry.id,
      taskId: row.id, taskKey: key, stage: row.stage, operation: retry.operation,
      generation: retry.generation, attempt: retry.attempt, maxAttempts: retry.maxAttempts, owner: input.owner ?? null,
      retryId: retry.id, now: ts, state: input.startImmediately === true ? 'running' : 'reserved',
    });
  });
}

/** Cancel reservations that never reached spawn/claim after the conservative grace period. */
export function reconcileExecutions(db: DB, graceMs: number, now: () => string = nowIso): number {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new ValidationError('execution reservation grace must be nonnegative');
  const ts = now();
  const cutoff = new Date(Date.parse(ts) - graceMs).toISOString();
  return transaction(db, () => {
    let count = 0;
    for (const id of abandonedExecutionIds(db, cutoff)) {
      const row = db.prepare('SELECT retry_id FROM task_execution WHERE id = ?').get(id) as { retry_id: string | null } | undefined;
      if (!row) continue;
      const retrySettled = row.retry_id ? settleRetryRow(db, row.retry_id, 'cancelled', ts, 'execution reservation abandoned') : false;
      if (settleExecution(db, id, 'cancelled', ts, 'execution reservation abandoned') || retrySettled) count += 1;
    }
    return count;
  });
}

/**
 * The task's current (reserved/running) execution, or null. A supervisor that did not make the
 * claim — the stale-claim reaper after a restart — reads this so its release is fenced on the
 * execution it actually observed instead of being an unfenced write.
 */
export function getCurrentExecution(db: DB, key: string): Execution | null {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return executionForTask(db, row.id, key);
}

/** Refresh a supervisor-owned execution heartbeat without changing task state. */
export function touchExecution(db: DB, id: string, now: () => string = nowIso): boolean {
  return transaction(db, () => touchExecutionRow(db, id, now()));
}
