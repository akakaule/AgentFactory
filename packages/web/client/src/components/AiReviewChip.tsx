import type { ReviewBrief } from '../types.js';
import { chipText, reviewSentence } from '../reviewText.js';
import { I } from '../icons.js';

/**
 * The AI review's verdict, from the review brief: "Changes needed", "Your call · 3", "Minor issues · 2",
 * "No issues found" or "Review pending", with the verdict sentence as its tooltip. Renders nothing
 * when no AI review is present. Shared by the board card and the drawer.
 */
export function AiReviewChip({ brief }: { brief: ReviewBrief | null | undefined }) {
  if (!brief) return null;
  const { label, detail } = chipText(brief);
  return (
    <>
      <span className={'af-airev af-rv-chip ' + brief.headline} title={reviewSentence(brief)}>
        {I.bot({})}
        <span className="tx">{label}</span>
      </span>
      {detail && <span className="af-rv-chipdetail">{detail}</span>}
    </>
  );
}
