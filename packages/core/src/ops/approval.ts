import type { DB } from '../db.js';
import type { Actor, DeliveryProvider, ExpectedRevision, ReviewBrief, ReviewRevision, Status, SubmissionSummary } from '../types.js';
import { NEXT_STAGE } from '../types.js';
import { buildReviewBrief } from '../reviewBrief.js';
import type { TaskRow } from '../repo/tasks.js';
import { setStatus, setStage, aiReviewFor, submissionFor } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { upsertDelivery, deliveryRowFor } from '../repo/delivery.js';
import { latestPrLinkUrl } from '../repo/links.js';
import { assertTransition } from '../transitions.js';
import { InvalidTransitionError, ValidationError } from '../errors.js';
import { resetRetryBudget as resetRetryBudgetRow } from '../repo/retry.js';

const short = (sha: string | null | undefined): string => (sha ? sha.slice(0, 7) : 'unknown');

/**
 * The revision gate: the human approves the submission they looked at. A named submission that is
 * no longer the stage's latest, or a named head that is not the submitted one, is refused. An
 * implementation whose branch was observed at a different head since submit is refused for every
 * caller — a new push needs its own review, it cannot inherit the previous revision's verdict —
 * including a human closing the review by a raw status move (ops/updateStatus.ts). Historical
 * tasks (no submission) approve as before.
 */
export function assertApprovableRevision(db: DB, row: TaskRow, expected: ExpectedRevision | null, requireExpected = false): SubmissionSummary | null {
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
    throw new InvalidTransitionError(`${row.key} changed since submission #${sub.id} (${short(sub.headSha)}) was reviewed: the branch is now at ${short(seen?.headSha)} (observed via ${seen?.source ?? 'git'} at ${seen?.observedAt ?? 'an unknown time'}${seen?.error ? `; the latest refresh failed: ${seen.error}` : ''}); request changes so the new revision is submitted and reviewed`);
  }
  // A raw status close (a board drag) is resolved against whatever is current when it lands, so
  // with a tracked submission it must say which one it approves: a replacement that arrived after
  // the human looked would otherwise be approved unseen. Historical tasks have none to name.
  if (requireExpected && !expected && sub)
    throw new InvalidTransitionError(`closing the review of ${row.key} must name the submission it approves (current: #${sub.id}); reload and retry, or use the approve action`);
  return sub;
}

/**
 * Approving while the git/provider observation of the head failed is allowed, but it is its own
 * audited human action, never a silent pass — on the approve action and a raw status close alike.
 * (A submission that never recorded a head — an older worker, no origin — says so in the approval
 * note instead: 'at an unknown revision'.)
 */
export function auditUnknownFreshness(db: DB, row: TaskRow, approved: SubmissionSummary | null, ts: string, actorUserId: number | null): void {
  const failed = approved?.stage === 'implementation' ? approved.lastObservation : null;
  if (!approved || !failed?.error) return;
  appendActivity(db, { taskId: row.id, type: 'comment', actor: 'human', createdAt: ts, actorUserId,
    body: `approved submission #${approved.id} with unknown revision freshness: the ${failed.source} observation at ${failed.observedAt} failed (${failed.error})` });
}

const DEFAULT_DELIVERY_REPAIR_ATTEMPTS = 2;

/** Approve-time routing decision: non-null ⇒ the implementation approve enters 'delivering'
 *  under this provider (reviewApprove computes it from the workspace's origin URL). */
export interface DeliverySeed { provider: DeliveryProvider; }

/**
 * Approving a code task over must-fix issues or open decisions is a deliberate call — the human
 * records why. Minor issues only stay one click, so warnings don't train people to type filler.
 * A pr-review task keeps its plain "Mark reviewed": its review lives on the PR, not here.
 */
function needsReason(row: TaskRow, brief: ReviewBrief | null): boolean {
  return row.kind === 'code' && (brief?.headline === 'changes_needed' || brief?.headline === 'your_call');
}

/** Whether approving this in-review task needs a reason — for paths that approve outside
 *  applyApproval (a raw in_review → done status move). */
export function approvalNeedsReason(db: DB, row: TaskRow): boolean {
  return needsReason(row, buildReviewBrief(aiReviewFor(db, row.id), row.acceptance_criteria, row.stage));
}

/** "2 must-fix, 3 open decisions and 2 minor issues" — the non-zero parts of the brief. Nothing
 *  parses this; the override comment is for the human reading the activity log. */
function openIssuesPhrase(brief: ReviewBrief): string {
  const { must, call, should, fyi } = brief.counts;
  const parts = [
    must > 0 ? `${must} must-fix` : null,
    call > 0 ? `${call} open decision${call === 1 ? '' : 's'}` : null,
    should + fyi > 0 ? `${should + fyi} minor issue${should + fyi === 1 ? '' : 's'}` : null,
  ].filter((p): p is string => p !== null);
  if (parts.length === 0) return 'the AI review';
  return parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)!}`;
}

/**
 * The approve action for an in_review task: a doc stage (description, or legacy plan) advances to
 * the next stage and re-queues; the implementation stage closes the task (human-only —
 * the final gate is never automated). With a `delivery` seed the implementation approve
 * routes to 'delivering' instead of 'done' — done then means the watcher verified the PR
 * merged, with actual check results retained (or a human force-completed). Runs INSIDE an
 * already-open transaction: `transaction()` cannot nest, and this body is shared by
 * `reviewApprove` (human) and `addComment`'s auto-approve hook (agent, clean doc-stage
 * reviews — that path never passes a delivery seed).
 *
 * `note` rides the status_change body, prefixing the stage-advance trail
 * (e.g. 'auto-approved: clean AI review; stage description → implementation').
 * `overrideReason` is the human's why, recorded on the override comment; it is required when the
 * review brief has must-fix issues or open decisions (headline changes_needed / your_call).
 * `revision` is the submission the human approved (reviewApprove's revision gate); it rides the
 * implementation status_change note and the delivery row (approved head vs the PR head seen later).
 */
export function applyApproval(db: DB, row: TaskRow, actor: Actor, ts: string, note?: string, actorUserId: number | null = null, delivery: DeliverySeed | null = null, overrideReason: string | null = null, revision: ReviewRevision | null = null): void {
  // Break-glass audit trail: approving while the *current* AI review has open findings
  // logs an override comment. Derived, no schema change; the override-rate KPI reads the
  // same condition from the activity log (findingsAtApproval). Pending/clean ⇒ no override.
  // The auto path can never hit this — a clean verdict is its precondition (so actorUserId
  // is the approving human here, never the agent).
  const review = aiReviewFor(db, row.id);
  const brief = buildReviewBrief(review, row.acceptance_criteria, row.stage);
  const reason = overrideReason?.trim() || null;
  if (actor === 'human' && needsReason(row, brief) && reason === null)
    throw new ValidationError('approving over must-fix issues or open decisions needs a reason');
  if (review && brief && (review.verdict === 'findings' || review.verdict === 'disputed')) {
    appendActivity(db, {
      taskId: row.id, type: 'comment', actor: 'human',
      body: `override: approved over ${openIssuesPhrase(brief)}${reason === null ? '' : `\n\nReason: ${reason}`}`,
      createdAt: ts, actorUserId,
    });
  }
  if (row.stage === 'implementation') {
    if (actor !== 'human') throw new InvalidTransitionError('the implementation review is approved by a human, never auto-approved');
    const to: Status = delivery ? 'delivering' : 'done';
    assertTransition('in_review', to, actor);
    setStatus(db, row.id, to, ts);
    // seed (or refresh, on a re-approval) the delivery row inside the same transaction — the
    // watcher must never find a delivering task it can't attribute to a provider/branch. The
    // repair budget is created only for the first episode; a successful worker resubmission must
    // not reset it or CI can bounce forever.
    if (delivery) {
      const newDeliveryEpisode = deliveryRowFor(db, row.id) === undefined;
      upsertDelivery(db, row.id, { provider: delivery.provider, branch: row.branch!, prUrl: latestPrLinkUrl(db, row.id), submissionId: revision?.submissionId ?? null, approvedHeadSha: revision?.headSha ?? null }, ts);
      if (newDeliveryEpisode)
        resetRetryBudgetRow(db, row.id, 'delivery', DEFAULT_DELIVERY_REPAIR_ATTEMPTS, ts, 'new delivery episode');
    }
    appendActivity(db, {
      taskId: row.id, type: 'status_change', actor, fromStatus: 'in_review', toStatus: to, createdAt: ts,
      body: [delivery ? 'approved — awaiting PR merge; check results remain visible' : '',
        revision ? `approved submission #${revision.submissionId} at ${revision.headSha ? revision.headSha.slice(0, 7) : 'an unknown revision'}` : '']
        .filter(Boolean).join('; '), actorUserId,
    });
    return;
  }
  const next = NEXT_STAGE[row.stage];
  assertTransition('in_review', 'queued', actor);
  setStage(db, row.id, next, ts);
  setStatus(db, row.id, 'queued', ts); // clears the claimant — the next stage is anyone's claim
  appendActivity(db, {
    taskId: row.id, type: 'status_change', actor, fromStatus: 'in_review', toStatus: 'queued', createdAt: ts,
    body: `${note ?? 'approved'}; stage ${row.stage} → ${next}`, actorUserId,
  });
}
