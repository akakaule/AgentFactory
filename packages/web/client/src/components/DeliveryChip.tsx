import type { DeliverySummary } from '../types.js';
import { I } from '../icons.js';

/**
 * Delivery-state chip, including while a task is being repaired — a one-line read of the watcher's last
 * observation of the PR + its checks (`task.delivery`). Mirrors AiReviewChip/FailureChip:
 * an inline pill, colour-coded by outcome (failing → error, passing/merged → ok, else neutral).
 * When a PR URL is known the whole chip is a link (stopPropagation so a card click still opens
 * the task, not the PR). Renders nothing without a delivery summary.
 */
export function DeliveryChip({ delivery }: { delivery: DeliverySummary | null }) {
  if (!delivery) return null;
  const { prState, checksState, prId, prUrl, headSha, approvedHeadSha, ciMode } = delivery;
  // The PR head is not the approved commit (a push after approval): its check verdict says nothing
  // about the approved delivery, and the watcher won't bounce for it.
  const otherCommit = !!headSha && !!approvedHeadSha && headSha.toLowerCase() !== approvedHeadSha.toLowerCase();

  const prRef = prId ? `PR #${prId.replace(/^#/, '')}` : 'PR';
  const checksText =
    otherCommit ? 'checks for another commit'
    : checksState === 'failing' ? 'checks failed'
    : checksState === 'pending' ? 'checks running'
    : checksState === 'passing' ? 'checks passing'
    : checksState === 'none' ? (ciMode === 'none' ? 'no CI by choice' : 'no checks') // ciMode 'none': the workspace ignores CI
    : null;

  const label =
    prState === 'not_found' ? 'no PR found'
    : prState === 'merged' ? `${prRef} merged · ${checksText ?? 'checks unknown'}`
    : prState === 'closed' ? `${prRef} closed`
    : prState === 'open' ? (checksText ? `${prRef} · ${checksText}` : `${prRef} open`)
    : 'checking…'; // 'unknown' — not yet polled

  // Tone: a failed pipeline reads as an error; a merged PR or green/no-op checks read as ok;
  // everything still in flight (pending / unknown / awaiting first poll) stays neutral.
  const tone =
    otherCommit && prState !== 'merged' ? ''
    : checksState === 'failing' ? ' fail'
    : prState === 'merged' || checksState === 'passing' || checksState === 'none' ? ' ok'
    : '';

  const title =
    `Delivery: ${label}` +
    (delivery.checkedAt ? '' : ' — awaiting first watcher poll');

  const inner = (<>
    {I.link({})}
    <span className="tx">{label}</span>
  </>);

  return prUrl ? (
    <a
      className={'af-delivery' + tone}
      href={prUrl}
      target="_blank"
      rel="noreferrer"
      title={title}
      onClick={(e) => e.stopPropagation()}
    >
      {inner}
    </a>
  ) : (
    <span className={'af-delivery' + tone} title={title}>
      {inner}
    </span>
  );
}
