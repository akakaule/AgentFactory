import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import type { RetryAttemptState, RetryBudget, RetryOperation, RetryReservation } from '../types.js';
import { latestAiReviewComments, latestFailureComments, latestRestartMarkerIds, latestResultIds } from './activity.js';
import { parseFailureComment } from '../failure.js';

interface BudgetRow {
  id: number; task_id: number; operation: string; generation: number; max_attempts: number;
  attempts_used: number; created_at: string;
}

interface AttemptRow {
  id: string; task_id: number; operation: string; generation: number; attempt: number;
  max_attempts: number; state: RetryAttemptState; reserved_at: string;
}

function currentBudgetRow(db: DB, taskId: number, operation: RetryOperation): BudgetRow | undefined {
  return db.prepare(
    `SELECT * FROM retry_budget WHERE task_id = ? AND operation = ? ORDER BY generation DESC LIMIT 1`,
  ).get(taskId, operation) as BudgetRow | undefined;
}

/** Recover only attempt data that is explicitly present in a legacy failure marker. */
function legacyBudgetSeed(db: DB, taskId: number, operation: RetryOperation): { used: number; max: number } | null {
  const source = operation === 'delivery'
    ? 'watcher'
    : operation.startsWith('dispatcher:')
      ? 'dispatcher'
      : operation.startsWith('reviewer:')
        ? 'reviewer'
        : null;
  if (!source) return null;
  const comment = latestFailureComments(db, [taskId]).get(taskId);
  if (!comment) return null;
  const parsed = parseFailureComment(comment.body);
  if (!parsed || parsed.source !== source || parsed.attempt === null || parsed.maxAttempts === null) return null;
  const superseded = Math.max(
    latestResultIds(db, [taskId]).get(taskId) ?? 0,
    latestAiReviewComments(db, [taskId]).get(taskId)?.id ?? 0,
    latestRestartMarkerIds(db, [taskId]).get(taskId) ?? 0,
  ) > comment.id;
  if (superseded) return null;
  return { used: Math.max(0, Math.min(parsed.attempt, parsed.maxAttempts)), max: parsed.maxAttempts };
}

/** Must be called inside an already-open transaction. */
export function ensureRetryBudget(
  db: DB,
  taskId: number,
  operation: RetryOperation,
  maxAttempts: number,
  now: string,
  resetReason: string | null = null,
): BudgetRow {
  const current = currentBudgetRow(db, taskId, operation);
  if (current) return current;
  const legacy = legacyBudgetSeed(db, taskId, operation);
  const max = legacy?.max ?? maxAttempts;
  const used = legacy?.used ?? 0;
  db.prepare(
    `INSERT INTO retry_budget(task_id, operation, generation, max_attempts, attempts_used, created_at, reset_reason)
     VALUES (?, ?, 1, ?, ?, ?, ?)`,
  ).run(taskId, operation, max, used, now, resetReason);
  return currentBudgetRow(db, taskId, operation)!;
}

export function budgetByTask(db: DB, taskId: number, operation: RetryOperation): RetryBudget | null {
  const row = currentBudgetRow(db, taskId, operation);
  if (!row) return null;
  return {
    taskKey: String(taskId), operation: row.operation, generation: row.generation,
    maxAttempts: row.max_attempts, attemptsUsed: row.attempts_used,
    remaining: Math.max(0, row.max_attempts - row.attempts_used),
    exhausted: row.attempts_used >= row.max_attempts,
  };
}

/** Reserve one slot atomically. The caller must already hold the core write transaction. */
export function reserveRetry(
  db: DB,
  taskId: number,
  taskKey: string,
  input: { operation: RetryOperation; maxAttempts: number },
  now: string,
): RetryReservation | null {
  const budget = ensureRetryBudget(db, taskId, input.operation, input.maxAttempts, now);
  const updated = db.prepare(
    `UPDATE retry_budget SET attempts_used = attempts_used + 1
     WHERE id = ? AND attempts_used < max_attempts`,
  ).run(budget.id);
  if (updated.changes === 0) return null;
  const after = db.prepare('SELECT * FROM retry_budget WHERE id = ?').get(budget.id) as unknown as BudgetRow;
  const id = randomUUID();
  db.prepare(
    `INSERT INTO retry_attempt(id, budget_id, attempt, state, reserved_at)
     VALUES (?, ?, ?, 'reserved', ?)`,
  ).run(id, budget.id, after.attempts_used, now);
  return {
    id, taskKey, operation: after.operation, generation: after.generation,
    attempt: after.attempts_used, maxAttempts: after.max_attempts, state: 'reserved', reservedAt: now,
  };
}

export function settleRetry(db: DB, id: string, state: Extract<RetryAttemptState, 'running' | 'succeeded' | 'failed' | 'cancelled'>, now: string, reason?: string): boolean {
  const row = db.prepare(
    `SELECT a.id, b.task_id, b.operation, b.generation, a.attempt, b.max_attempts, a.state, a.reserved_at
       FROM retry_attempt a JOIN retry_budget b ON b.id = a.budget_id WHERE a.id = ?`,
  ).get(id) as AttemptRow | undefined;
  if (!row) return false;
  if (row.state === state) return true; // idempotent repeated settlement
  if (row.state !== 'reserved' && row.state !== 'running') return false;
  if (state === 'running') {
    db.prepare(`UPDATE retry_attempt SET state = 'running' WHERE id = ? AND state = 'reserved'`).run(id);
    return true;
  }
  db.prepare(
    `UPDATE retry_attempt SET state = ?, settled_at = ?, terminal_reason = ?
     WHERE id = ? AND state IN ('reserved','running')`,
  ).run(state, now, reason ?? null, id);
  if (state === 'cancelled') {
    db.prepare('UPDATE retry_budget SET attempts_used = MAX(0, attempts_used - 1) WHERE id = (SELECT budget_id FROM retry_attempt WHERE id = ?)').run(id);
    // A cancelled reservation never became an attempt. Remove it so the same numbered slot can
    // be reserved again after a transient pre-launch/post-delivery failure.
    db.prepare('DELETE FROM retry_attempt WHERE id = ?').run(id);
  }
  return true;
}

/** Start a fresh generation for an exact operation or all operation scopes with a prefix. */
export function resetRetryBudget(
  db: DB,
  taskId: number,
  operation: RetryOperation,
  maxAttempts: number,
  now: string,
  reason: string,
): void {
  const rows = db.prepare(
    `SELECT operation, MAX(generation) AS generation FROM retry_budget
     WHERE task_id = ? AND (operation = ? OR operation LIKE ?) GROUP BY operation`,
  ).all(taskId, operation, `${operation}:%`) as Array<{ operation: string; generation: number }>;
  if (rows.length === 0) {
    db.prepare(
      `INSERT INTO retry_budget(task_id, operation, generation, max_attempts, attempts_used, created_at, reset_reason)
       VALUES (?, ?, 1, ?, 0, ?, ?)`,
    ).run(taskId, operation, maxAttempts, now, reason);
    return;
  }
  for (const row of rows) {
    db.prepare(
      `INSERT INTO retry_budget(task_id, operation, generation, max_attempts, attempts_used, created_at, reset_reason)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    ).run(taskId, row.operation, row.generation + 1, maxAttempts, now, reason);
  }
}

export function deliveryBudgetExhausted(db: DB, taskId: number): boolean {
  const row = currentBudgetRow(db, taskId, 'delivery');
  return row !== undefined && row.attempts_used >= row.max_attempts;
}
