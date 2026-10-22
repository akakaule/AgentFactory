import type { DB } from '../db.js';
import type { Execution, RetryOperation, Status } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, claimableQueuedRow, touch } from '../repo/tasks.js';
import {
  createExecution, abandonedExecutionIds, currentExecution, executionById, executionForTask, settleExecution, supersedeExecution,
  operationPhase, EXECUTION_LEASE_MS, touchExecution as touchExecutionRow,
} from '../repo/execution.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow } from '../repo/retry.js';
import { appendActivity } from '../repo/activity.js';
import { buildFailureComment } from '../failure.js';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export { EXECUTION_LEASE_MS };

export interface ReserveExecutionInput { operation: RetryOperation; maxAttempts: number; owner?: string | null | undefined; startImmediately?: boolean | undefined; }

/**
 * Reserve the next attempt of an operation and record it as the task's execution, or null once
 * the operation's budget is spent. Throws InvalidTransitionError — consuming no budget — when the
 * task is not in the status the operation acts on, a worker-phase task is not claim-eligible
 * (unmet dependency, exhausted delivery budget), or another supervisor's execution still owns
 * that phase of the task (a racing supervisor skips the task for now; it is not exhausted).
 */
export function reserveExecution(db: DB, key: string, input: ReserveExecutionInput, now: () => string = nowIso): Execution | null {
  if (!input.operation.trim()) throw new ValidationError('execution operation is required');
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new ValidationError('maxAttempts must be a positive integer');
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    const ts = now();
    const required = operationPhase(input.operation);
    if (required !== undefined && row.status !== required)
      throw new InvalidTransitionError(`${key} is ${row.status}; ${input.operation} acts on ${required} tasks`);
    if (required === 'queued' && !claimableQueuedRow(db, row.id))
      throw new InvalidTransitionError(`${key} is not claimable (unmet dependency or exhausted delivery budget)`);
    // A live execution from an earlier phase (e.g. the worker's, before review) no longer owns
    // the task; one serving the current phase does until its heartbeat outlives the lease.
    const live = currentExecution(db, row.id);
    if (live && operationPhase(live.operation) === row.status) {
      const lastSeen = Date.parse(live.heartbeat_at ?? live.reserved_at);
      if (Date.parse(ts) - lastSeen < EXECUTION_LEASE_MS)
        throw new InvalidTransitionError(`${key} already has a live execution (${live.operation})`);
      supersedeExecution(db, live, ts);
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

const ABANDONED = 'execution reservation abandoned';

/**
 * Cancel reservations that never reached spawn/claim after the conservative grace period. One
 * that still served the task's phase (its supervisor died before the worker claimed) leaves one
 * failure/v1 note, in the same transaction, so the restart's respawn is explained; a leftover from
 * an earlier phase (a review the task was pulled back from) is retired silently.
 */
export function reconcileExecutions(db: DB, graceMs: number, now: () => string = nowIso): number {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new ValidationError('execution reservation grace must be nonnegative');
  const ts = now();
  const cutoff = new Date(Date.parse(ts) - graceMs).toISOString();
  return transaction(db, () => {
    let count = 0;
    for (const id of abandonedExecutionIds(db, cutoff)) {
      const row = executionById(db, id);
      if (!row) continue;
      const retrySettled = row.retry_id ? settleRetryRow(db, row.retry_id, 'cancelled', ts, ABANDONED) : false;
      if (!settleExecution(db, id, 'cancelled', ts, ABANDONED) && !retrySettled) continue;
      count += 1;
      const task = db.prepare('SELECT status FROM task WHERE id = ?').get(row.task_id) as { status: Status } | undefined;
      if (task === undefined || operationPhase(row.operation) !== task.status) continue;
      appendActivity(db, {
        taskId: row.task_id, type: 'comment', actor: 'agent', createdAt: ts,
        body: buildFailureComment({
          reason: 'crashed',
          detail: `${row.operation} execution ${row.id} was abandoned before its session took over the task`,
          source: row.operation.split(':')[0] ?? row.operation,
          // no attempt numbers: the abandoned reservation is refunded, so it never counts as one
          body: 'Its supervisor stopped, or its process tree was killed, before the session took over. The attempt was not counted; a running supervisor picks the task up again.',
        }),
      });
      touch(db, row.task_id, ts);
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
