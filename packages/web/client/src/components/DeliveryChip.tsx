import type { DeliverySummary } from '../types.js';
import { I } from '../icons.js';

/**
 * Delivery-state chip for a 'delivering' task — a one-line read of the watcher's last
 * observation of the PR + its checks (`task.delivery`). Mirrors AiReviewChip/FailureChip:
 * an inline pill, colour-coded by outcome (failing → error, passing/merged → ok, else neutral).
 * When a PR URL is known the whole chip is a link (stopPropagation so a card click still opens
 * the task, not the PR). Renders nothing without a delivery summary.
 */
export function DeliveryChip({ delivery }: { delivery: DeliverySummary | null }) {
  if (!delivery) return null;
  const { prState, checksState, prId, prUrl } = delivery;

  const prRef = prId ? `PR #${prId}` : 'PR';
  const checksText =
    checksState === 'failing' ? 'checks failed'
    : checksState === 'pending' ? 'checks running'
    : checksState === 'passing' ? 'checks passing'
    : checksState === 'none' ? 'no checks'
    : null;

  const label =
    prState === 'not_found' ? 'no PR found'
    : prState === 'merged' ? `${prRef} merged · verifying`
    : prState === 'closed' ? `${prRef} closed`
    : prState === 'open' ? (checksText ? `${prRef} · ${checksText}` : `${prRef} open`)
    : 'checking…'; // 'unknown' — not yet polled

  // Tone: a failed pipeline reads as an error; a merged PR or green/no-op checks read as ok;
  // everything still in flight (pending / unknown / awaiting first poll) stays neutral.
  const tone =
    checksState === 'failing' ? ' fail'
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
