import type { TaskDetailView } from './types.js';
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

/**
 * Everything that still stands between the task and done, in a fixed order: the revision lines,
 * must-fix issues, undecided your-call issues, unmet criteria, the active failure note, blocked, and
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
  return [
    revision.stale,
    revision.unknown,
    revision.review,
    must > 0 ? `${must} must-fix ${must === 1 ? 'issue' : 'issues'}` : null,
    undecided > 0 ? `${undecided} ${undecided === 1 ? 'issue needs' : 'issues need'} your decision` : null,
    notMet.length > 0 ? `Criteria not met: ${notMet.join(', ')}` : null,
    task.failure ? `Failed: ${task.failure.reason}` : null,
    task.status === 'blocked' ? 'Blocked' : null,
    task.status === 'delivering' && delivery?.prState !== 'merged' ? 'PR not merged yet' : null,
  ].filter((c): c is string => c !== null);
}
