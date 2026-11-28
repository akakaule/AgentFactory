import type { AiReviewSummary, Complexity, IntakeSettings, IntakeSummary, ReviewBrief, Risk, Stage, Status, TaskKind } from './types.js';
import { intakeEnabledFor } from './intakeSettings.js';

/**
 * Task Intelligence auto-approve (opt-in per workspace): an implementation review approves itself
 * when there is nothing left for a human to read and the task was rated low-risk.
 *
 * Every condition must hold. Anything unknown, stale or unclear leaves the review for a human,
 * exactly as before this policy existed:
 * - the workspace is in `autoApproveWorkspaces` and Task Intelligence assesses it;
 * - a code task's implementation review, still in review, on a branch;
 * - the AI review is clean and bound to the current submission, which recorded a pushed head;
 *   no must-fix items, no open calls, every acceptance criterion clear (the inline-approve bar);
 * - the current assessment rates risk and complexity at or under the configured ceilings
 *   (at most medium), and Task Intelligence did not flag the task for attention;
 * - the workspace origin is a git host, so the approval opens a PR and CI gates the merge.
 *
 * Pure: the caller gathers the facts, so every branch is testable without a database.
 */
export interface AutoApproveFacts {
  settings: IntakeSettings;
  workspace: string;
  task: { kind: TaskKind; stage: Stage; status: Status; branch: string | null };
  review: AiReviewSummary | null;
  brief: ReviewBrief | null;
  submissionHeadSha: string | null;
  intake: IntakeSummary | null;
  /** The workspace origin parses as a recognizable git host (an approval routes to delivering). */
  gitHost: boolean;
}

export type AutoApproveDecision = { approve: true; reason: string } | { approve: false; why: string };

const RISK_RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2, critical: 3 };
const COMPLEXITY_RANK: Record<Complexity, number> = { trivial: 0, small: 1, medium: 2, large: 3, architectural: 4 };

/** Whether the policy could apply to this task at all — cheap, so callers can skip the git lookup. */
export function autoApproveCandidate(settings: IntakeSettings, workspace: string, task: AutoApproveFacts['task']): boolean {
  return settings.autoApproveWorkspaces.includes(workspace) && intakeEnabledFor(settings, workspace)
    && task.kind === 'code' && task.stage === 'implementation' && task.status === 'in_review' && task.branch !== null;
}

export function autoApproveDecision(f: AutoApproveFacts): AutoApproveDecision {
  const no = (why: string): AutoApproveDecision => ({ approve: false, why });
  if (!autoApproveCandidate(f.settings, f.workspace, f.task)) return no('auto-approve does not apply to this task');

  const { review, brief } = f;
  if (!review || review.verdict !== 'clean') return no('the AI review is not clean');
  if (review.binding !== 'current') return no(`the AI review is ${review.binding ?? 'unbound'}, not bound to the current submission`);
  if (review.consensus?.status === 'disputed') return no('the reviewers disagree');
  if (!f.submissionHeadSha) return no('the submission recorded no pushed head');
  if (!brief || brief.counts.must > 0 || brief.counts.call > 0) return no('the review has open issues or decisions');
  if (!brief.criteria.every((c) => c.status === 'clear')) return no('not every acceptance criterion is clear');

  const { intake } = f;
  if (intake?.state !== 'current' || intake.assessment.status !== 'assessed') return no('there is no current Task Intelligence assessment');
  if (intake.policy?.eligibility === 'attention_required') return no('Task Intelligence flagged the task for attention');
  const { risk, complexity } = intake.assessment.decisions;
  if (RISK_RANK[risk.value] > RISK_RANK[f.settings.autoApproveMaxRisk]) return no(`risk is ${risk.value}`);
  if (COMPLEXITY_RANK[complexity.value] > COMPLEXITY_RANK[f.settings.autoApproveMaxComplexity]) return no(`complexity is ${complexity.value}`);

  if (!f.gitHost) return no('the workspace origin is not a git host, so no PR or CI would follow');

  return { approve: true, reason: `auto-approved: clean AI review; Task Intelligence risk ${risk.value}, complexity ${complexity.value} (${intake.assessment.provider.name})` };
}
