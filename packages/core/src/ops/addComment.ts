import type { DB } from '../db.js';
import type { Activity, AddCommentInput } from '../types.js';
import { transaction } from '../transaction.js';
import { commentSchema, parse } from '../validate.js';
import { findRowByKey, touch, toDetail } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { parseAiReviewComment } from '../aiReview.js';
import { applyApproval } from './approval.js';
import { NotFoundError, InvalidTransitionError } from '../errors.js';
import { reviewSubmissionFingerprint } from '../reviewConsensus.js';
import { nowIso } from '../time.js';
import { assertExecutionOwnership } from '../repo/execution.js';
import { isIntakeMarker } from '../intake.js';
import { isFailureTriageMarker } from '../failureTriage.js';
import { isCurrentSubmission, latestSubmissionFor, reviewBinding, submissionById } from '../repo/submissions.js';
import { aiReviewFor, intakeForTask } from '../repo/tasks.js';
import { buildReviewBrief } from '../reviewBrief.js';
import { autoApproveCandidate, autoApproveDecision } from '../autoApprove.js';
import { getIntakeSettings } from './intakeSettings.js';
import { assertApprovableRevision } from './approval.js';
import { parseRemoteUrl, resolveOriginUrl, type RemoteRef } from '../remote.js';

export function addComment(
  db: DB,
  key: string,
  input: AddCommentInput,
  now: () => string = nowIso,
  resolveOrigin: (repoPath: string) => string | null = resolveOriginUrl,
): Activity {
  const { body } = parse(commentSchema, { body: input.body });
  if (isIntakeMarker(body)) throw new InvalidTransitionError('intake markers can only be written by dedicated core operations');
  if (isFailureTriageMarker(body)) throw new InvalidTransitionError('failure-triage markers can only be written by dedicated core operations');
  // Implementation auto-approve needs the workspace's git host, which takes a git call: resolve it
  // here, outside the transaction, and only for an AI review of a task the policy could apply to.
  let autoApproveRemote: RemoteRef | null = null;
  const settings = getIntakeSettings(db);
  if (settings.autoApproveWorkspaces.length > 0 && parseAiReviewComment(body)) {
    const pre = findRowByKey(db, key);
    if (pre && autoApproveCandidate(settings, pre.workspace_name, { kind: pre.kind, stage: pre.stage, status: pre.status, branch: pre.branch }))
      autoApproveRemote = parseRemoteUrl(resolveOrigin(pre.workspace_repo_path) ?? '');
  }
  return transaction(db, () => {
    const parsed = parseAiReviewComment(body);
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    // A settled fence may still comment while it is the task's LATEST execution (a recovery note
    // after release, a note after submit): nothing newer exists, so nothing can be overwritten.
    if (input.actor === 'agent') assertExecutionOwnership(db, row.id, key, input.executionId, { allowSettledSuccess: true, allowSettledFailure: true });
    const current = row;
    const submission = parsed?.consensus?.submission;
    if (submission && (submission.key !== key || submission.fingerprint !== reviewSubmissionFingerprint(toDetail(db, current)))) {
      throw new InvalidTransitionError('review submission changed before publication');
    }
    // A review bound to a submission that is not the current stage's latest reviewed something that
    // was replaced (or an earlier stage's deliverable): refuse it before publication, like a
    // changed consensus fingerprint.
    const revision = parsed?.revision;
    if (revision) {
      const named = submissionById(db, revision.submissionId);
      if (!named || !isCurrentSubmission(db, row, named))
        throw new InvalidTransitionError(`review names submission #${revision.submissionId}, which is not the current submission of ${key}`);
    }
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'comment', actor: input.actor, body, createdAt: ts, actorUserId: input.actorUserId ?? null });
    touch(db, row.id, ts);
    const comment = recentActivity(db, row.id, 1)[0]!; // capture before the hook appends more rows
    // Auto-approve policy: a clean ai-review/v1 verdict on an in-review doc stage advances
    // the task to its next stage. Keyed on the incoming body itself (the newest activity by
    // construction), regardless of actor — the reviewer loop posts via HTTP (human) or MCP
    // (agent). Findings, malformed markers, and the implementation stage all escalate to
    // the human gate instead. Reviewers stay advisory; this policy lives here, in core.
    // A review bound to content that changed since its submission is not proof: no auto-approve.
    // Nor is an unbound review of a stage whose submission is tracked — it names no revision, so
    // it cannot vouch for the current content. Only historical stages (nothing tracked) keep the
    // legacy unbound auto-approve.
    const stale = revision
      ? reviewBinding(db, current, revision) !== 'current'
      : latestSubmissionFor(db, row.id, current.stage) !== undefined;
    if (parsed && !stale && parsed.consensus?.status !== 'disputed' && parsed.findings.length === 0 && current.status === 'in_review' && current.stage !== 'implementation') {
      applyApproval(db, current, 'agent', ts, 'auto-approved: clean AI review');
    } else if (parsed && current.stage === 'implementation' && autoApproveCandidate(settings, current.workspace_name, { kind: current.kind, stage: current.stage, status: current.status, branch: current.branch })) {
      // Task Intelligence auto-approve (core/src/autoApprove.ts): every fact is read after this
      // comment was stored, so the review being judged is the one just published.
      const review = aiReviewFor(db, current.id);
      const submission = latestSubmissionFor(db, current.id, current.stage);
      const decision = autoApproveDecision({
        settings, workspace: current.workspace_name,
        task: { kind: current.kind, stage: current.stage, status: current.status, branch: current.branch },
        review, brief: buildReviewBrief(review, current.acceptance_criteria, current.stage),
        submissionHeadSha: submission?.head_sha ?? null, intake: intakeForTask(db, current), gitHost: autoApproveRemote !== null,
      });
      if (decision.approve && submission && autoApproveRemote) {
        // the same revision gate a human approval passes, naming the submission the review was bound to
        const approved = assertApprovableRevision(db, current, { submissionId: submission.id, headSha: submission.head_sha }, true);
        applyApproval(db, current, 'agent', ts, undefined, null, { provider: autoApproveRemote.provider }, null,
          approved ? { submissionId: approved.id, headSha: approved.headSha } : null, { reason: decision.reason });
      }
    }
    return comment;
  });
}
