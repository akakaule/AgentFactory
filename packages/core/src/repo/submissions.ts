import { createHash } from 'node:crypto';
import type { DB } from '../db.js';
import type { Stage, SubmissionSummary, RevisionSource, RevisionObservationSource, RevisionFreshness, ReviewBinding } from '../types.js';

/**
 * Repo primitives for `task_submission` (migration #30): one row per accepted submit_result,
 * naming the revision it handed over. Run INSIDE a caller's transaction. The rows are never
 * rewritten by cleanup — deleting the worktree or branch leaves the reviewed revision readable.
 */
export interface SubmissionRow {
  id: number; task_id: number; stage: Stage; execution_id: string | null; branch: string | null;
  head_sha: string | null; base_sha: string | null; content_hash: string | null;
  revision_source: RevisionSource; observed_at: string; created_at: string;
  last_head_sha: string | null; last_observed_at: string | null;
  last_observation_source: RevisionObservationSource | null; last_observation_error: string | null;
}

/** The task content a doc-stage submission's identity is computed from. */
export interface DocContent { spec: string; acceptance_criteria: string; plan: string | null; }

/** A doc stage's content identity: sha256 over exactly what that stage delivered. */
export function contentHash(stage: Stage, c: DocContent): string | null {
  if (stage === 'implementation') return null;
  const parts = stage === 'description' ? [c.spec, c.acceptance_criteria] : [c.plan ?? ''];
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export interface InsertSubmission {
  taskId: number; stage: Stage; executionId: string | null; branch: string | null;
  headSha: string | null; baseSha: string | null; contentHash: string | null; source: RevisionSource; ts: string;
}

export function insertSubmission(db: DB, s: InsertSubmission): number {
  const r = db.prepare(
    `INSERT INTO task_submission (task_id, stage, execution_id, branch, head_sha, base_sha, content_hash, revision_source, observed_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(s.taskId, s.stage, s.executionId, s.branch, s.headSha, s.baseSha, s.contentHash, s.source, s.ts, s.ts);
  return Number(r.lastInsertRowid);
}

/** The latest submission of the given stage — the one a review/approval of that stage concerns. */
export function latestSubmissionFor(db: DB, taskId: number, stage: Stage): SubmissionRow | undefined {
  return db.prepare('SELECT * FROM task_submission WHERE task_id = ? AND stage = ? ORDER BY id DESC LIMIT 1')
    .get(taskId, stage) as SubmissionRow | undefined;
}

export function submissionById(db: DB, id: number): SubmissionRow | undefined {
  return db.prepare('SELECT * FROM task_submission WHERE id = ?').get(id) as SubmissionRow | undefined;
}

/**
 * Record an observation of the branch head. `last_head_sha` is the last head actually SEEN: an
 * attempt that learned no head (a failed refresh, a provider check without one) records its
 * source/time/error but keeps the known head, so an outage can never erase a proven mismatch.
 * Returns whether anything changed.
 */
export function recordObservation(db: DB, id: number, o: { headSha: string | null; source: RevisionObservationSource; error: string | null; ts: string }): boolean {
  const before = submissionById(db, id);
  if (!before) return false;
  const head = o.headSha ?? before.last_head_sha;
  const changed = before.last_head_sha !== head || before.last_observation_error !== o.error || before.last_observation_source !== o.source;
  db.prepare('UPDATE task_submission SET last_head_sha = ?, last_observed_at = ?, last_observation_source = ?, last_observation_error = ? WHERE id = ?')
    .run(head, o.ts, o.source, o.error, id);
  return changed;
}

/**
 * Is the submitted revision still what is there? Implementation: unknown when never resolved;
 * stale once a different head was observed — even if a later refresh failed, the known mismatch
 * stands until a head is seen again; otherwise unknown when the latest observation failed. Doc
 * stages: stale when the task's content no longer hashes to the submitted identity.
 */
export function freshnessOf(s: SubmissionRow, task: DocContent): RevisionFreshness {
  if (s.stage !== 'implementation') return s.content_hash !== null && s.content_hash === contentHash(s.stage, task) ? 'current' : 'stale';
  if (s.head_sha === null) return 'unknown';
  if (s.last_head_sha !== null && s.last_head_sha !== s.head_sha) return 'stale';
  return s.last_observation_error !== null ? 'unknown' : 'current';
}

export function toSubmissionSummary(s: SubmissionRow, task: DocContent): SubmissionSummary {
  return {
    id: s.id, stage: s.stage, executionId: s.execution_id, branch: s.branch,
    headSha: s.head_sha, baseSha: s.base_sha, contentHash: s.content_hash,
    source: s.revision_source, observedAt: s.observed_at, createdAt: s.created_at,
    lastObservation: s.last_observed_at === null || s.last_observation_source === null ? null : {
      headSha: s.last_head_sha, source: s.last_observation_source, observedAt: s.last_observed_at, error: s.last_observation_error,
    },
    freshness: freshnessOf(s, task),
  };
}

/**
 * Is `s` the submission a review of the task can concern now — its current stage's latest? A
 * submission of an earlier stage (a delayed spec review after implementation was submitted) or
 * a replaced one is not.
 */
export function isCurrentSubmission(db: DB, task: { id: number; stage: Stage }, s: SubmissionRow): boolean {
  return s.task_id === task.id && s.stage === task.stage && latestSubmissionFor(db, task.id, s.stage)?.id === s.id;
}

/**
 * How a review's named revision relates to what is there now: 'legacy' when unbound; 'superseded'
 * when it names a submission that is not the current stage's latest (replaced, or of an earlier
 * stage); 'unverified' when it names an implementation submission whose head was never resolved —
 * nothing ties the diff it saw to what was submitted; 'stale' when its head is not the submitted
 * head or the submission itself went stale; otherwise 'current'.
 */
export function reviewBinding(db: DB, task: DocContent & { id: number; stage: Stage }, revision: { submissionId: number; headSha: string | null } | null | undefined): ReviewBinding {
  if (!revision) return 'legacy';
  const s = submissionById(db, revision.submissionId);
  if (!s || !isCurrentSubmission(db, task, s)) return 'superseded';
  if (s.stage === 'implementation' && s.head_sha === null) return 'unverified';
  if (s.head_sha !== null && revision.headSha !== null && revision.headSha !== s.head_sha) return 'stale';
  return freshnessOf(s, task) === 'stale' ? 'stale' : 'current';
}
