import { randomUUID } from 'node:crypto';
import type { DB } from '../db.js';
import type { Execution, ExecutionState, Stage } from '../types.js';
import { InvalidTransitionError } from '../errors.js';

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

/**
 * Validate a mutation's execution fence. Tasks created before migration 26 have no execution
 * history and retain the legacy direct-core behavior; every supervisor-owned execution is fenced
 * once it exists. The check is intended to run inside the caller's write transaction.
 */
export function assertExecutionOwnership(
  db: DB,
  taskId: number,
  taskKey: string,
  executionId: string | undefined,
  opts: { allowSettledSuccess?: boolean; allowSettledFailure?: boolean; requireRunning?: boolean } = {},
): ExecutionRow | undefined {
  const latest = latestExecution(db, taskId);
  if (executionId === undefined) {
    // An owned execution that is still live fences the task from its very first claim: an
    // unfenced caller is an old build or a superseded session. With nothing live there is no
    // owner to protect, so claim-less callers (an interactive review, a producer note) still work.
    if (latest !== undefined && latest.owner !== null && (latest.state === 'reserved' || latest.state === 'running'))
      throw new InvalidTransitionError(`execution identity is required for ${taskKey}; restart the worker and supervisor together`);
    return undefined;
  }
  const current = currentExecution(db, taskId);
  if (current?.id === executionId && (!opts.requireRunning || current.state === 'running')) return current;
  if (opts.allowSettledSuccess && latest?.id === executionId && latest.state === 'succeeded') return latest;
  if (opts.allowSettledFailure && latest?.id === executionId && latest.state === 'failed') return latest;
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
