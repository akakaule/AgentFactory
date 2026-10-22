import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import type { Execution, ExecutionState, Stage, Status } from '../types.js';
import { InvalidTransitionError } from '../errors.js';
import { settleRetry } from './retry.js';

/**
 * A live execution whose heartbeat is younger than this still owns its task, so a second
 * reservation or a foreign claim is refused instead of superseding it. Supervisors refresh their
 * executions every tick; only an owner that crashed (or stalled for minutes) ages past it.
 */
export const EXECUTION_LEASE_MS = 5 * 60_000;

/** The task status an operation acts on (its phase); undefined for an operation without a lifecycle rule. */
export function operationPhase(operation: string): Status | undefined {
  if (operation.startsWith('dispatcher:') || operation.startsWith('worker:')) return 'queued';
  if (operation === 'reviewer:feedback-eval') return 'delivering';
  if (operation.startsWith('reviewer:') || operation.startsWith('visualization:')) return 'in_review';
  return undefined;
}

/**
 * SQL over alias `task`: another claimant's live worker-phase execution, still inside its lease,
 * owns the task. Only the owner (or its `-aN` worker label) adopts an owned reservation; an
 * owner-less one is open to any claimant. Bind with `reservedByOtherParams`.
 */
export const RESERVED_BY_OTHER_SQL = `EXISTS (
  SELECT 1 FROM task_execution live
   WHERE live.task_id = task.id AND live.state IN ('reserved','running')
     AND (live.operation LIKE 'dispatcher:%' OR live.operation LIKE 'worker:%')
     AND COALESCE(live.heartbeat_at, live.reserved_at) > ?
     AND live.owner IS NOT NULL AND live.owner IS NOT ?
     AND (? IS NULL OR substr(?, 1, length(live.owner) + 2) != live.owner || '-a'))`;

export const reservedByOtherParams = (claimant: string | null, now: string): Array<string | null> =>
  [new Date(Date.parse(now) - EXECUTION_LEASE_MS).toISOString(), claimant, claimant, claimant];

interface ExecutionRow {
  id: string; task_id: number; stage: Stage; operation: string; generation: number; attempt: number; max_attempts: number;
  owner: string | null; state: ExecutionState; reserved_at: string; started_at: string | null;
  heartbeat_at: string | null; retry_after_at: string | null; terminal_reason: string | null;
  retry_id: string | null; task_key?: string;
}

function toExecution(row: ExecutionRow, taskKey: string): Execution {
  return {
    id: row.id, taskKey, stage: row.stage, operation: row.operation, generation: row.generation,
    attempt: row.attempt, maxAttempts: row.max_attempts, owner: row.owner, state: row.state, reservedAt: row.reserved_at,
    startedAt: row.started_at, heartbeatAt: row.heartbeat_at, retryAfterAt: row.retry_after_at,
    terminalReason: row.terminal_reason,
  };
}

export function createExecution(
  db: DB,
  input: { id?: string | undefined; taskId: number; taskKey: string; stage: Stage; operation: string; generation: number; attempt: number; maxAttempts: number; owner: string | null; retryId?: string | null; now: string; state?: ExecutionState },
): Execution {
  const id = input.id ?? randomUUID();
  const state = input.state ?? 'running';
  db.prepare(
    `INSERT INTO task_execution(id, task_id, stage, operation, generation, attempt, max_attempts, owner, state,
       reserved_at, started_at, heartbeat_at, retry_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(id, input.taskId, input.stage, input.operation, input.generation, input.attempt, input.maxAttempts, input.owner, state,
    input.now, state === 'running' ? input.now : null, state === 'running' ? input.now : null, input.retryId ?? null);
  return {
    id, taskKey: input.taskKey, stage: input.stage, operation: input.operation,
    generation: input.generation, attempt: input.attempt, maxAttempts: input.maxAttempts, owner: input.owner, state,
    reservedAt: input.now, startedAt: state === 'running' ? input.now : null,
    heartbeatAt: state === 'running' ? input.now : null, retryAfterAt: null, terminalReason: null,
  };
}

export function executionById(db: DB, id: string): ExecutionRow | undefined {
  return db.prepare('SELECT * FROM task_execution WHERE id = ?').get(id) as ExecutionRow | undefined;
}

export function currentExecution(db: DB, taskId: number): ExecutionRow | undefined {
  return db.prepare(
    `SELECT * FROM task_execution
      WHERE task_id = ? AND state IN ('reserved','running')
        AND rowid = (
          SELECT rowid FROM task_execution
           WHERE task_id = ?
           ORDER BY reserved_at DESC, rowid DESC LIMIT 1
        )`,
  ).get(taskId, taskId) as ExecutionRow | undefined;
}

export function latestExecution(db: DB, taskId: number): ExecutionRow | undefined {
  return db.prepare(
    'SELECT * FROM task_execution WHERE task_id = ? ORDER BY reserved_at DESC, rowid DESC LIMIT 1',
  ).get(taskId) as ExecutionRow | undefined;
}

/** No newer execution of the task serves the same phase (a reviewer's run is not newer worker work). */
export function isLatestOfPhase(db: DB, row: ExecutionRow): boolean {
  const phase = operationPhase(row.operation) ?? row.operation;
  const newer = db.prepare(
    `SELECT operation FROM task_execution
      WHERE task_id = ? AND id != ?
        AND (reserved_at > ? OR (reserved_at = ? AND rowid > (SELECT rowid FROM task_execution WHERE id = ?)))`,
  ).all(row.task_id, row.id, row.reserved_at, row.reserved_at, row.id) as Array<{ operation: string }>;
  return newer.every((e) => (operationPhase(e.operation) ?? e.operation) !== phase);
}

/**
 * Validate a mutation's execution fence. Tasks created before migration 28 have no execution
 * history and retain the legacy direct-core behavior; every execution is fenced once it exists.
 * The check is intended to run inside the caller's write transaction.
 */
export function assertExecutionOwnership(
  db: DB,
  taskId: number,
  taskKey: string,
  executionId: string | undefined,
  opts: { allowSettledSuccess?: boolean; allowSettledFailure?: boolean; requireRunning?: boolean; observability?: boolean } = {},
): ExecutionRow | undefined {
  const latest = latestExecution(db, taskId);
  if (executionId === undefined) {
    // A live execution fences the task from its very first claim, whoever made it (a claim with
    // no worker label included): an unfenced caller is an old build or a superseded session. With
    // nothing live there is nothing to protect, so claim-less callers (an interactive review, a
    // producer note) still work.
    if (latest !== undefined && (latest.state === 'reserved' || latest.state === 'running'))
      throw new InvalidTransitionError(`execution identity is required for ${taskKey}; restart the worker and supervisor together`);
    return undefined;
  }
  const current = currentExecution(db, taskId);
  if (current?.id === executionId && (!opts.requireRunning || current.state === 'running')) return current;
  // A settled fence may still write while it cannot overwrite anything newer. A note (success or
  // failure, as the caller allows) while it is the task's latest execution. An observability write
  // (transcript, metrics) in any state while it is the latest of its own phase: a run's final
  // transcript and usage survive its release or a merged-elsewhere cancel, and cannot clobber the
  // review reserved after it.
  const own = executionById(db, executionId);
  if (own !== undefined && own.task_id === taskId) {
    if (opts.observability === true && isLatestOfPhase(db, own)) return own;
    if (latest?.id === own.id &&
        ((opts.allowSettledSuccess === true && own.state === 'succeeded') || (opts.allowSettledFailure === true && own.state === 'failed'))) return own;
  }
  throw new InvalidTransitionError(`execution ${executionId} is not the current execution for ${taskKey}`);
}

export function executionForTask(db: DB, taskId: number, taskKey: string): Execution | null {
  const row = currentExecution(db, taskId);
  return row ? toExecution(row, taskKey) : null;
}

export function executionForId(db: DB, id: string, taskKey: string): Execution | null {
  const row = executionById(db, id);
  return row ? toExecution(row, taskKey) : null;
}

export function startExecution(db: DB, id: string, now: string, owner?: string): void {
  db.prepare(
    `UPDATE task_execution SET state = 'running', owner = COALESCE(?, owner), started_at = COALESCE(started_at, ?), heartbeat_at = ?
     WHERE id = ? AND state = 'reserved'`,
  ).run(owner ?? null, now, now, id);
}

export function touchExecution(db: DB, id: string, now: string): boolean {
  return db.prepare(
    `UPDATE task_execution SET heartbeat_at = ? WHERE id = ? AND state = 'running'`,
  ).run(now, id).changes > 0;
}

export function settleExecution(db: DB, id: string, state: Exclude<ExecutionState, 'reserved' | 'running'>, now: string, reason?: string): boolean {
  const changed = db.prepare(
    `UPDATE task_execution SET state = ?, terminal_reason = ?, heartbeat_at = COALESCE(heartbeat_at, ?)
     WHERE id = ? AND state IN ('reserved','running')`,
  ).run(state, reason ?? null, now, id).changes;
  return changed > 0;
}

/**
 * Retire a live execution whose owner outlived its lease. 'failed', not 'cancelled': the crashed
 * owner's attempt stays counted, so an owner that keeps dying is still bounded by maxAttempts.
 */
export function supersedeExecution(db: DB, row: ExecutionRow, now: string): void {
  const reason = 'execution superseded after its lease expired';
  if (row.retry_id) settleRetry(db, row.retry_id, 'failed', now, reason);
  settleExecution(db, row.id, 'failed', now, reason);
}

export function abandonedExecutionIds(db: DB, cutoff: string): string[] {
  return (db.prepare(
    `SELECT e.id
       FROM task_execution e
       JOIN task t ON t.id = e.task_id
      WHERE (e.state = 'reserved' AND e.reserved_at <= ?)
         OR (e.state = 'running' AND t.status = 'queued' AND (e.heartbeat_at IS NULL OR e.heartbeat_at <= ?))
      ORDER BY e.reserved_at ASC`,
  ).all(cutoff, cutoff) as Array<{ id: string }>).map((r) => r.id);
}
