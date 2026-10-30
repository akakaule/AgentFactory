import type { DB } from '../db.js';
import type { Verification, VerificationStatus } from '../types.js';

/** Repo primitives for `task_verification` (migration #33). Run INSIDE a caller's transaction. */
interface VerificationRow {
  id: number; task_id: number; execution_id: string; command: string; status: VerificationStatus;
  exit_code: number | null; head_before: string | null; head_after: string | null;
  clean_before: number | null; clean_after: number | null; log: string; truncated: number;
  started_at: string; finished_at: string; submission_id: number | null; valid_for_revision: number | null;
}

export interface InsertVerification {
  taskId: number; executionId: string; command: string; status: VerificationStatus;
  exitCode: number | null; headBefore: string | null; headAfter: string | null;
  cleanBefore: boolean | null; cleanAfter: boolean | null; log: string; truncated: boolean;
  startedAt: string; finishedAt: string;
}

const flag = (v: boolean | null): number | null => (v === null ? null : v ? 1 : 0);
const bool = (v: number | null): boolean | null => (v === null ? null : v === 1);

function toVerification(row: VerificationRow, taskKey: string): Verification {
  return {
    id: row.id, taskKey, executionId: row.execution_id, command: row.command, status: row.status,
    exitCode: row.exit_code, headBefore: row.head_before, headAfter: row.head_after,
    cleanBefore: bool(row.clean_before), cleanAfter: bool(row.clean_after), log: row.log, truncated: row.truncated === 1,
    startedAt: row.started_at, finishedAt: row.finished_at,
    submissionId: row.submission_id, validForRevision: bool(row.valid_for_revision),
  };
}

export function insertVerification(db: DB, v: InsertVerification): number {
  const r = db.prepare(
    `INSERT INTO task_verification(task_id, execution_id, command, status, exit_code, head_before, head_after,
       clean_before, clean_after, log, truncated, started_at, finished_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(v.taskId, v.executionId, v.command, v.status, v.exitCode, v.headBefore, v.headAfter,
    flag(v.cleanBefore), flag(v.cleanAfter), v.log, v.truncated ? 1 : 0, v.startedAt, v.finishedAt);
  return Number(r.lastInsertRowid);
}

/** The most recent record of one execution of a task, or null. */
export function latestVerificationFor(db: DB, taskId: number, taskKey: string, executionId: string): Verification | null {
  const row = db.prepare(
    'SELECT * FROM task_verification WHERE task_id = ? AND execution_id = ? ORDER BY id DESC LIMIT 1'
  ).get(taskId, executionId) as VerificationRow | undefined;
  return row ? toVerification(row, taskKey) : null;
}

/** Bind a record to the submission it was handed over with, and whether it proves that revision. */
export function bindVerification(db: DB, id: number, submissionId: number, validForRevision: boolean): void {
  db.prepare('UPDATE task_verification SET submission_id = ?, valid_for_revision = ? WHERE id = ?')
    .run(submissionId, validForRevision ? 1 : 0, id);
}
