import type { DB } from '../db.js';
import type { RetryAttemptState, RetryBudget, RetryOperation, RetryReservation } from '../types.js';
import { transaction } from '../transaction.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { findRowByKey } from '../repo/tasks.js';
import { budgetByTask, reserveRetry as reserveRetryRow, resetRetryBudget as resetRetryBudgetRow, settleRetry as settleRetryRow, reconcileRetry as reconcileRetryRow, reconcileAbandonedRetryReservations as reconcileAbandonedRetryReservationsRow, recordRetryFailure as recordRetryFailureRow, activeRetryAttempt, markRetryRunning } from '../repo/retry.js';
import { nowIso } from '../time.js';
import { reconcileMergedDelivery } from './delivery.js';

function assertInput(operation: RetryOperation, maxAttempts: number): void {
  if (!operation.trim()) throw new ValidationError('retry operation is required');
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new ValidationError('maxAttempts must be a positive integer');
}

export interface ReserveRetryInput { operation: RetryOperation; maxAttempts: number; }
export interface SettleRetryInput { state: Extract<RetryAttemptState, 'running' | 'succeeded' | 'failed' | 'cancelled'>; reason?: string | undefined; }
export interface ReconcileRetryInput { actualKey: string; operation: RetryOperation; maxAttempts: number; }
export interface RecordRetryFailureInput { operation: RetryOperation; maxAttempts: number; attempt: number; reason: string; }

export function beginRetry(db: DB, key: string, input: ReserveRetryInput, now: () => string = nowIso): RetryReservation | null | 'busy' {
  assertInput(input.operation, input.maxAttempts);
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    if (activeRetryAttempt(db, row.id, input.operation)) return 'busy';
    const reservation = reserveRetryRow(db, row.id, key, input, now());
    return reservation ? markRetryRunning(db, reservation) : null;
  });
}

export function reserveRetry(db: DB, key: string, input: ReserveRetryInput, now: () => string = nowIso): RetryReservation | null {
  assertInput(input.operation, input.maxAttempts);
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    const ts = now();
    if (input.operation.startsWith('dispatcher:') && (row.status === 'done' || reconcileMergedDelivery(db, row, ts))) return null;
    return reserveRetryRow(db, row.id, key, input, ts);
  });
}

export function settleRetry(db: DB, id: string, input: SettleRetryInput, now: () => string = nowIso): boolean {
  if (!id.trim()) throw new ValidationError('retry attempt id is required');
  return transaction(db, () => settleRetryRow(db, id, input.state, now(), input.reason));
}

export function reconcileRetry(db: DB, id: string, input: ReconcileRetryInput, now: () => string = nowIso): RetryReservation | null {
  if (!id.trim()) throw new ValidationError('retry attempt id is required');
  assertInput(input.operation, input.maxAttempts);
  return transaction(db, () => {
    const row = findRowByKey(db, input.actualKey);
    if (!row) throw new NotFoundError(`task not found: ${input.actualKey}`);
    return reconcileRetryRow(db, id, row.id, input.actualKey, input, now());
  });
}

export function reconcileAbandonedRetryReservations(db: DB, graceMs: number, now: () => string = nowIso): number {
  if (!Number.isFinite(graceMs) || graceMs < 0) throw new ValidationError('retry reservation grace must be nonnegative');
  const cutoff = new Date(Date.parse(now()) - graceMs).toISOString();
  return transaction(db, () => reconcileAbandonedRetryReservationsRow(db, cutoff));
}

export function recordRetryFailure(db: DB, key: string, input: RecordRetryFailureInput, now: () => string = nowIso): void {
  assertInput(input.operation, input.maxAttempts);
  if (!Number.isInteger(input.attempt) || input.attempt < 1) throw new ValidationError('retry attempt must be a positive integer');
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  transaction(db, () => recordRetryFailureRow(db, row.id, input, now(), input.reason));
}

export function getRetryBudget(db: DB, key: string, operation: RetryOperation): RetryBudget | null {
  if (!operation.trim()) throw new ValidationError('retry operation is required');
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  const budget = budgetByTask(db, row.id, operation);
  return budget ? { ...budget, taskKey: key } : null;
}

/** Reset only the owning operation. */
export function resetRetryBudget(db: DB, key: string, operation: RetryOperation, maxAttempts: number, reason = 'operator restart', now: () => string = nowIso): void {
  assertInput(operation, maxAttempts);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  transaction(db, () => resetRetryBudgetRow(db, row.id, operation, maxAttempts, now(), reason));
}
