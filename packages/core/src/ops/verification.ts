import type { DB } from '../db.js';
import type { RecordVerificationInput, Verification } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { assertExecutionOwnership } from '../repo/execution.js';
import { insertVerification, latestVerificationFor } from '../repo/verifications.js';
import { recordVerificationSchema, parse } from '../validate.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Store a verify-command run the runner captured for the task's live execution. Only the running
 * execution may record one: a superseded or settled execution is refused, so a late run can never
 * stand in for the current attempt. The record is unbound (submission_id / valid_for_revision NULL).
 */
export function recordVerification(db: DB, key: string, input: RecordVerificationInput, now: () => string = nowIso): Verification {
  const v = parse(recordVerificationSchema, input);
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    assertExecutionOwnership(db, row.id, key, v.executionId, { requireRunning: true });
    const ts = now();
    insertVerification(db, {
      taskId: row.id, executionId: v.executionId, command: v.command, status: v.status,
      exitCode: v.exitCode ?? null, headBefore: v.headBefore ?? null, headAfter: v.headAfter ?? null,
      cleanBefore: v.cleanBefore ?? null, cleanAfter: v.cleanAfter ?? null, log: v.log, truncated: v.truncated,
      startedAt: v.startedAt ?? ts, finishedAt: v.finishedAt ?? ts,
    });
    return latestVerificationFor(db, row.id, key, v.executionId)!;
  });
}

/** The latest verification an execution of the task recorded, or null when it has none. */
export function latestVerification(db: DB, key: string, executionId: string): Verification | null {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return latestVerificationFor(db, row.id, key, executionId);
}
