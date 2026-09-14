import type { DB } from '../db.js';
import type { AgentSessionView } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { updateProgress, touchSession, endSession, listLiveSessions } from '../repo/agentSessions.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';
import { currentExecution, touchExecution } from '../repo/execution.js';
import { InvalidTransitionError } from '../errors.js';

/**
 * Standalone entry points (MCP report_progress, the dispatcher, the HTTP heartbeat route)
 * that resolve a task key and wrap the repo primitive in a transaction. The claim/submit
 * paths call the repo primitives directly inside their own transactions instead.
 */

/** Record an agent milestone. Throws if the task is unknown; no-ops if it has no live session. */
export function reportProgress(
  db: DB,
  key: string,
  input: { message: string; tokensIn?: number | undefined; tokensOut?: number | undefined; executionId?: string | undefined },
  now: () => string = nowIso,
): void {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  transaction(db, () => {
    const current = currentExecution(db, row.id);
    if (input.executionId !== undefined && (!current || current.id !== input.executionId))
      throw new InvalidTransitionError(`execution ${input.executionId} is not the current execution for ${key}`);
    if (input.executionId !== undefined && current && current.state !== 'running')
      throw new InvalidTransitionError(`execution ${input.executionId} is not running`);
    const ts = now();
    if (input.executionId !== undefined) touchExecution(db, input.executionId, ts);
    updateProgress(db, { taskId: row.id, message: input.message, tokensIn: input.tokensIn ?? null, tokensOut: input.tokensOut ?? null, now: ts });
  });
}

/** Liveness heartbeat for a task's live session (no-op if unknown/not live). */
export function touchAgentSession(db: DB, key: string, now: () => string = nowIso): void {
  const row = findRowByKey(db, key);
  if (!row) return;
  transaction(db, () => touchSession(db, row.id, now()));
}

/** End a task's live session (dispatcher exit/crash/release safety-net; idempotent). */
export function endAgentSession(db: DB, key: string, now: () => string = nowIso): void {
  const row = findRowByKey(db, key);
  if (!row) return;
  transaction(db, () => endSession(db, row.id, now()));
}

export function listLiveAgents(db: DB): AgentSessionView[] {
  return listLiveSessions(db);
}
