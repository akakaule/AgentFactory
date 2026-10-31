import type { Stage, TaskDetailView } from './types.js';
import { defaultDecisions, type ReviewDecisions } from './composeReviewFeedback.js';
import { criterionLabel } from './reviewText.js';

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : 'unknown');

/** Which revision is under review, and whether it is still what is there (AF-148). Core refuses a
 *  stale implementation approval; the panel says so up front instead of failing on click. */
export function revisionLines(task: TaskDetailView): { line: string | null; stale: string | null; unknown: string | null; review: string | null } {
  const sub = task.submission ?? null;
  if (!sub) return { line: null, stale: null, unknown: null, review: null };
  const seen = sub.lastObservation;
  const binding = task.aiReview?.binding;
  return {
    line: sub.headSha ? `Submission #${sub.id} · commit ${short(sub.headSha)}` : `Submission #${sub.id}`,
    stale: sub.stage === 'implementation' && sub.freshness === 'stale'
      ? `The branch moved to ${short(seen?.headSha)} after this submission. Approval is blocked until the new revision is submitted and reviewed — request changes.`
      : sub.freshness === 'stale' ? 'The deliverable was edited after this submission.' : null,
    unknown: sub.stage === 'implementation' && sub.freshness === 'unknown'
      ? `Revision freshness unknown: ${seen?.error ?? 'no commit was recorded at submit'}. Approving records that.`
      : null,
    review: binding === 'stale' || binding === 'superseded' ? 'This AI review is for an older revision.'
      : binding === 'unverified' ? 'This AI review cannot be matched to the submitted commit: none was recorded at submit.'
      : binding === 'legacy' ? 'This AI review names no revision (recorded before revisions were tracked).' : null,
  };
}

/** What the verification evidence (AF-171) leaves open: a runner run for an older commit, or no
 *  runner run at all on an implementation task whose workspace names a verify command. Older servers
 *  that serve no evidence raise nothing. */
export function evidenceConcerns(task: TaskDetailView): { stale: string | null; missing: string | null } {
  const evidence = task.evidence;
  if (!evidence) return { stale: null, missing: null };
  const runner = evidence.filter((e) => e.source === 'runner');
  return {
    stale: runner.some((e) => e.state === 'stale') ? 'Verification is for an older commit' : null,
    missing: runner.length === 0 && task.stage === 'implementation' && task.verifyCommand ? 'No runner verification' : null,
  };
}

/**
 * Everything that still stands between the task and done, in a fixed order: the revision lines,
 * stale or missing runner verification, must-fix issues, undecided your-call issues, unmet criteria, the active failure note, blocked, and
 * an unmerged PR. `decisions` are the reviewer's current choices (defaults when omitted). [] = nothing.
 */
export function remainingConcerns(task: TaskDetailView, decisions?: ReviewDecisions): string[] {
  const brief = task.reviewBrief ?? null;
  const revision = revisionLines(task);
  const chosen = decisions ?? defaultDecisions(brief);
  const must = brief?.counts.must ?? 0;
  const undecided = brief && brief.headline !== 'pending'
    ? brief.issues.filter((i) => i.group === 'call' && chosen[i.id] === undefined).length : 0;
  const notMet = (brief?.criteria ?? []).filter((r) => r.status === 'not_met').map(criterionLabel);
  const delivery = task.delivery ?? null;
  const evidence = evidenceConcerns(task);
  return [
    revision.stale,
    revision.unknown,
    revision.review,
    evidence.stale,
    evidence.missing,
    must > 0 ? `${must} must-fix ${must === 1 ? 'issue' : 'issues'}` : null,
    undecided > 0 ? `${undecided} ${undecided === 1 ? 'issue needs' : 'issues need'} your decision` : null,
    notMet.length > 0 ? `Criteria not met: ${notMet.join(', ')}` : null,
    task.failure ? `Failed: ${task.failure.reason}` : null,
    task.status === 'blocked' ? 'Blocked' : null,
    task.status === 'delivering' && delivery?.prState !== 'merged' ? 'PR not merged yet' : null,
  ].filter((c): c is string => c !== null);
}

/** The approve button's label: implementation approvals on a git-host branch go to delivery. */
export function approveLabel(stage: Stage, willDeliver: boolean): string {
  if (stage !== 'implementation') return 'Approve → implementation';
  return willDeliver ? 'Approve → deliver' : 'Approve';
}

/**
 * The one thing to do next, naming only actions the drawer already has (AF-181). `willDeliver`
 * defaults to the drawer's own rule. null = nothing to suggest for this status.
 */
export function nextAction(task: TaskDetailView, willDeliver = task.stage === 'implementation' && task.branch != null): string | null {
  switch (task.status) {
    case 'blocked': return 'Unblock or cancel';
    case 'delivering': return 'Wait for the PR to merge, or pull it back';
    case 'cancelled': return 'Reopen or archive';
    case 'in_review': break;
    default: return null;
  }
  if (task.stage === 'implementation' && task.submission?.freshness === 'stale') return 'Request changes: the branch moved';
  const brief = task.reviewBrief ?? null;
  if ((brief?.counts.must ?? 0) > 0) return 'Request changes';
  if (brief?.headline === 'your_call') return 'Decide each your-call issue, then request changes or approve anyway';
  return approveLabel(task.stage, willDeliver);
}
