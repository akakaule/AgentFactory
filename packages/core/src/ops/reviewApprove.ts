import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { applyApproval, type DeliverySeed } from './approval.js';
import { parseRemoteUrl, resolveOriginUrl } from '../remote.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { nowIso } from '../time.js';
import { appendActivity } from '../repo/activity.js';
import { submissionFor, type TaskRow } from '../repo/tasks.js';
import type { ExpectedRevision, SubmissionSummary } from '../types.js';

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

/**
 * The revision gate: the human approves the submission they looked at. A named submission that is
 * no longer the stage's latest, or a named head that is not the submitted one, is refused. An
 * implementation whose branch was observed at a different head since submit is refused for every
 * caller — a new push needs its own review, it cannot inherit the previous revision's verdict.
 * Historical tasks (no submission) approve as before.
 */
function assertApprovableRevision(db: DB, row: TaskRow, expected: ExpectedRevision | null): SubmissionSummary | null {
  const sub = submissionFor(db, row);
  if (expected) {
    if (!sub) throw new InvalidTransitionError(`${row.key} has no recorded submission #${expected.submissionId} to approve`);
    if (expected.submissionId !== sub.id)
      throw new InvalidTransitionError(`approval names submission #${expected.submissionId}, but the current submission of ${row.key} is #${sub.id}; review the current submission first`);
    if (expected.headSha != null && sub.headSha !== null && expected.headSha !== sub.headSha)
      throw new InvalidTransitionError(`approval names revision ${short(expected.headSha)}, but submission #${sub.id} is at ${short(sub.headSha)}`);
  }
  if (sub && sub.stage === 'implementation' && sub.freshness === 'stale') {
    const seen = sub.lastObservation;
    throw new InvalidTransitionError(`${row.key} changed since submission #${sub.id} (${short(sub.headSha)}) was reviewed: the branch is now at ${short(seen?.headSha)} (observed via ${seen?.source ?? 'git'} at ${seen?.observedAt ?? 'an unknown time'}); request changes so the new revision is submitted and reviewed`);
  }
  return sub;
}

/**
 * Human approval of an in_review task. Stage-aware: doc stages advance and re-queue;
 * the implementation stage closes the task — via 'delivering' (the watcher verifies the
 * PR merge before done, preserving actual check results) when the task has a branch and its workspace's
 * origin is a recognizable git host, straight to 'done' exactly as before otherwise
 * (doc-stage history, legacy no-branch tasks, pr-review tasks, unrecognizable/missing
 * remotes). `resolveOrigin` is injectable for tests; it shells out to git, so it runs
 * BEFORE the transaction — never inside the write lock. `overrideReason` is required when the
 * review has must-fix issues or open decisions (see applyApproval). `expected` names the submission
 * (and head) the human reviewed; see assertApprovableRevision.
 */
export function reviewApprove(
  db: DB,
  key: string,
  now: () => string = nowIso,
  actorUserId: number | null = null,
  resolveOrigin: (repoPath: string) => string | null = resolveOriginUrl,
  overrideReason: string | null = null,
  expected: ExpectedRevision | null = null,
): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'in_review') throw new InvalidTransitionError(`approve requires in_review (got ${row.status})`);
  let delivery: DeliverySeed | null = null;
  if (row.stage === 'implementation' && row.kind === 'code' && row.branch !== null) {
    const remote = parseRemoteUrl(resolveOrigin(row.workspace_repo_path) ?? '');
    if (remote) delivery = { provider: remote.provider };
  }
  return transaction(db, () => {
    const current = findRowByKey(db, key);
    if (!current || current.status !== 'in_review' || current.updated_at !== row.updated_at)
      throw new InvalidTransitionError(`task changed while resolving its delivery: ${key}`);
    const ts = now();
    const approved = assertApprovableRevision(db, current, expected);
    // Approving while the git/provider observation of the head failed is allowed, but it is its
    // own audited human action, never a silent pass. (A submission that never recorded a head —
    // an older worker, no origin — says so in the approval note: 'at an unknown revision'.)
    const failed = approved?.stage === 'implementation' ? approved.lastObservation : null;
    if (approved && failed?.error) {
      appendActivity(db, { taskId: current.id, type: 'comment', actor: 'human', createdAt: ts, actorUserId,
        body: `approved submission #${approved.id} with unknown revision freshness: the ${failed.source} observation at ${failed.observedAt} failed (${failed.error})` });
    }
    applyApproval(db, current, 'human', ts, undefined, actorUserId, delivery, overrideReason,
      approved ? { submissionId: approved.id, headSha: approved.headSha } : null);
    return toDetail(db, findRowByKey(db, key)!);
  });
}
