import type { DB } from '../db.js';
import type { SubmissionSummary } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, touch } from '../repo/tasks.js';
import { latestSubmissionFor, submissionById, recordObservation, toSubmissionSummary } from '../repo/submissions.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export interface RevisionObservationInput {
  /** The submission the observer read; defaults to the current stage's latest. */
  submissionId?: number | undefined;
  /** The branch head now seen; null when it could not be observed (pass `error`). */
  headSha: string | null;
  source: 'git' | 'provider';
  error?: string | null | undefined;
}

/**
 * Record what the git adapter (before approval) or the delivery provider (PR head) currently sees
 * for a submission's branch. A head that differs from the submitted one makes the submission —
 * and every review bound to it — stale; a failed observation makes its freshness unknown. Only the
 * latest submission of its stage is updated: an observation for a superseded one is dropped.
 * Bumps the task (→ getVersion → UI refetch) only when the observation changed.
 */
export function observeRevision(db: DB, key: string, input: RevisionObservationInput, now: () => string = nowIso): SubmissionSummary | null {
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    return observeRevisionInTx(db, row.id, input, now());
  });
}

/** observeRevision's body for callers already inside a transaction (the watcher's delivery check). */
export function observeRevisionInTx(db: DB, taskId: number, input: RevisionObservationInput, ts: string): SubmissionSummary | null {
  const row = db.prepare('SELECT stage FROM task WHERE id = ?').get(taskId) as { stage: 'description' | 'plan' | 'implementation' } | undefined;
  if (!row) return null;
  const s = input.submissionId === undefined ? latestSubmissionFor(db, taskId, row.stage) : submissionById(db, input.submissionId);
  if (!s || s.task_id !== taskId || latestSubmissionFor(db, taskId, s.stage)?.id !== s.id) return null;
  const error = input.error?.trim() || null;
  if (recordObservation(db, s.id, { headSha: input.headSha, source: input.source, error, ts })) touch(db, taskId, ts);
  const task = db.prepare('SELECT spec, acceptance_criteria, plan FROM task WHERE id = ?').get(taskId) as unknown as { spec: string; acceptance_criteria: string; plan: string | null };
  return toSubmissionSummary(submissionById(db, s.id)!, task);
}
