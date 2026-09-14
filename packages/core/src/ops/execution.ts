import type { DB } from '../db.js';
import type { Execution, RetryOperation } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { createExecution, abandonedExecutionIds, settleExecution, touchExecution as touchExecutionRow } from '../repo/execution.js';
import { reserveRetry as reserveRetryRow, settleRetry as settleRetryRow } from '../repo/retry.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';

export interface ReserveExecutionInput { operation: RetryOperation; maxAttempts: number; owner?: string | null | undefined; startImmediately?: boolean | undefined; }

export function reserveExecution(db: DB, key: string, input: ReserveExecutionInput, now: () => string = nowIso): Execution | null {
  if (!input.operation.trim()) throw new ValidationError('execution operation is required');
  if (!Number.isInteger(input.maxAttempts) || input.maxAttempts < 1) throw new ValidationError('maxAttempts must be a positive integer');
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    const ts = now();
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

/** Refresh a supervisor-owned execution heartbeat without changing task state. */
export function touchExecution(db: DB, id: string, now: () => string = nowIso): boolean {
  return transaction(db, () => touchExecutionRow(db, id, now()));
}
