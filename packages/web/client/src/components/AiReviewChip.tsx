import type { AiReviewSummary } from '../types.js';
import { I } from '../icons.js';

/**
 * The automated-review verdict chip, derived from the latest `ai-review:` comment.
 * Renders nothing when no AI review is present; green "clean" at zero findings,
 * amber "N findings" otherwise. Shared by the in_review card and the drawer.
 */
export function AiReviewChip({ review }: { review: AiReviewSummary | null }) {
  if (!review) return null;
  const clean = review.findings === 0;
  return (
    <span
      className={'af-airev' + (clean ? ' clean' : '')}
      title={clean ? 'Automated AI review: no findings' : `Automated AI review: ${review.findings} open finding(s)`}
    >
      {I.bot({})}
      <span className="tx">
        AI review: {clean ? 'clean' : `${review.findings} finding${review.findings === 1 ? '' : 's'}`}
      </span>
    </span>
  );
}
