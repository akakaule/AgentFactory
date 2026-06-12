import type { AiReviewSummary } from '../types.js';
import { I } from '../icons.js';

/**
 * The automated-review verdict chip, derived from the latest `ai-review/v1` comment.
 * Renders nothing when no AI review is present; green "clean" at zero findings, amber
 * "N findings" when open, grey "pending" when a newer result is awaiting re-review.
 * Shared by the in_review card and the drawer.
 */
export function AiReviewChip({ review }: { review: AiReviewSummary | null }) {
  if (!review) return null;
  const { verdict, findings } = review;
  const label = verdict === 'pending' ? 'pending'
    : verdict === 'clean' ? 'clean'
    : `${findings} finding${findings === 1 ? '' : 's'}`;
  const title = verdict === 'pending' ? 'Automated AI review: a newer result is awaiting re-review'
    : verdict === 'clean' ? 'Automated AI review: no findings'
    : `Automated AI review: ${findings} open finding${findings === 1 ? '' : 's'}`;
  return (
    <span className={'af-airev' + (verdict === 'clean' ? ' clean' : verdict === 'pending' ? ' pending' : '')} title={title}>
      {I.bot({})}
      <span className="tx">AI review: {label}</span>
    </span>
  );
}
