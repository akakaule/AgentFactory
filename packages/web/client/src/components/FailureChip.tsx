import type { FailureSummary } from '../types.js';
import { I } from '../icons.js';

/** Friendly labels for the known supervisor failure reasons; unknown reasons render as-is. */
const FAILURE_LABELS: Record<string, string> = {
  timeout: 'Timed out',
  crashed: 'Crashed',
  stale: 'Stale claim',
  permission_denied: 'Permission denied',
  max_attempts: 'Out of attempts',
  review_failed: 'Auto-review failed',
  ci_failed: 'CI failed',
  pr_closed: 'PR closed',
  merge_conflict: 'Merge conflict',
};

export function failureLabel(failure: FailureSummary): string {
  return FAILURE_LABELS[failure.reason] ?? failure.reason;
}

/**
 * The supervisor-failure chip, derived from the latest `failure/v1` note. Tells the operator
 * *why* a task is stuck (timeout / crash / permission / out-of-attempts) at a glance, instead
 * of scrolling the activity log. Skip-listed failures (no auto-retry left) read stronger.
 * Renders nothing when there is no current failure. Mirrors AiReviewChip.
 */
export function FailureChip({ failure }: { failure: FailureSummary | null }) {
  if (!failure) return null;
  const label = failureLabel(failure);
  const attempts = failure.attempt !== null && failure.maxAttempts !== null ? ` ${failure.attempt}/${failure.maxAttempts}` : '';
  const title =
    `Last supervisor failure: ${label}${failure.detail ? ` — ${failure.detail}` : ''}` +
    (failure.skipListed ? ' · skip-listed (no auto-retry left; needs you)' : '');
  return (
    <span className={'af-fail' + (failure.skipListed ? ' stuck' : '')} title={title}>
      {I.info({})}
      <span className="tx">{label}{failure.skipListed ? ' · stuck' : attempts}</span>
    </span>
  );
}
