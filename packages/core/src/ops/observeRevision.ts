import type { DB } from '../db.js';
import type { RevisionReadTicket, SubmissionSummary } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, touch } from '../repo/tasks.js';
import { latestSubmissionFor, submissionById, recordObservation, toSubmissionSummary, issueReadTicket, ticketIsCurrent, type SubmissionRow } from '../repo/submissions.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export interface RevisionObservationInput {
  /** The submission the observer read; defaults to the current stage's latest. */
  submissionId?: number | undefined;
  /** The branch head now seen; null when it could not be observed (pass `error`). */
  headSha: string | null;
  source: 'git' | 'provider';
  error?: string | null | undefined;
  /** The read ticket the board issued before the observer read (issueRevisionReadTicket). The
   *  observation is recorded only when no read that started later was recorded already. Without one
   *  (an older caller) the observation takes the next ticket as it records. */
  readTicket?: number | undefined;
  /** When the observer began its read, on its own clock: shown as the observation's "as of" time
   *  (never later than the board's), never used for ordering. */
  readStartedAt?: string | undefined;
}

/** The submission a reader concerns: the named one if it is still its stage's latest, else none. */
function currentSubmission(db: DB, taskId: number, submissionId: number | undefined): SubmissionRow | undefined {
  const row = db.prepare('SELECT stage FROM task WHERE id = ?').get(taskId) as { stage: 'description' | 'plan' | 'implementation' } | undefined;
  if (!row) return undefined;
  const s = submissionId === undefined ? latestSubmissionFor(db, taskId, row.stage) : submissionById(db, submissionId);
  if (!s || s.task_id !== taskId || latestSubmissionFor(db, taskId, s.stage)?.id !== s.id) return undefined;
  return s;
}

/**
 * Issue a read ticket for a task's current submission (or the named one, while it is still current):
 * every reader of the branch head (the board's git refresh, the watcher's provider poll) takes one
 * before it reads and passes it back with what it saw. Null when there is no current submission.
 */
export function issueRevisionReadTicket(db: DB, key: string, submissionId?: number): RevisionReadTicket | null {
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    const s = currentSubmission(db, row.id, submissionId);
    return s ? { submissionId: s.id, ticket: issueReadTicket(db, s.id) } : null;
  });
}

/**
 * Record what the git adapter (before approval) or the delivery provider (PR head) currently sees
 * for a submission's branch. A head that differs from the submitted one makes the submission —
 * and every review bound to it — stale; a failed observation makes its freshness unknown. Only the
 * latest submission of its stage is updated: an observation for a superseded one is dropped, and so
 * is one whose read ticket is not above the latest recorded one (a reader that started later won).
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
  const s = currentSubmission(db, taskId, input.submissionId);
  if (!s) return null;
  const task = db.prepare('SELECT spec, acceptance_criteria, plan FROM task WHERE id = ?').get(taskId) as unknown as { spec: string; acceptance_criteria: string; plan: string | null };
  if (input.readTicket !== undefined && !ticketIsCurrent(s, input.readTicket)) return toSubmissionSummary(s, task);
  const ticket = input.readTicket ?? issueReadTicket(db, s.id);
  const asOf = input.readStartedAt !== undefined && input.readStartedAt < ts ? input.readStartedAt : ts;
  const error = input.error?.trim() || null;
  if (recordObservation(db, s.id, { headSha: input.headSha, source: input.source, error, ts: asOf, ticket })) touch(db, taskId, ts);
  return toSubmissionSummary(submissionById(db, s.id)!, task);
}
