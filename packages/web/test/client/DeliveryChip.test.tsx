import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DeliveryChip } from '../../client/src/components/DeliveryChip.js';
import type { DeliverySummary } from '../../client/src/types.js';

const delivery = (over: Partial<DeliverySummary>): DeliverySummary => ({
  provider: 'github',
  branch: 'feature/AF-1-x',
  prUrl: null,
  prId: '12',
  prState: 'open',
  checksState: 'pending',
  failing: [],
  checkedAt: '2026-07-02T00:00:00.000Z',
  stateChangedAt: '2026-07-02T00:00:00.000Z',
  ...over,
});

describe('DeliveryChip', () => {
  it('renders nothing without a delivery summary', () => {
    const { container } = render(<DeliveryChip delivery={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows an open PR with running checks', () => {
    render(<DeliveryChip delivery={delivery({ prState: 'open', checksState: 'pending' })} />);
    expect(screen.getByText('PR #12 · checks running')).toBeInTheDocument();
  });

  it('shows a merged PR with its actual check result', () => {
    render(<DeliveryChip delivery={delivery({ prState: 'merged', checksState: 'passing' })} />);
    expect(screen.getByText('PR #12 merged · checks passing')).toBeInTheDocument();
  });

  it('shows a merged GitHub PR with failed checks and only one number prefix', () => {
    render(<DeliveryChip delivery={delivery({ prId: '#3', prState: 'merged', checksState: 'failing' })} />);
    expect(screen.getByText('PR #3 merged · checks failed')).toBeInTheDocument();
  });

  it('shows failed checks with the error tone', () => {
    const { container } = render(<DeliveryChip delivery={delivery({ prState: 'open', checksState: 'failing' })} />);
    expect(screen.getByText('PR #12 · checks failed')).toBeInTheDocument();
    expect(container.querySelector('.af-delivery.fail')).toBeTruthy();
  });

  it('shows "no PR found" when the PR is absent', () => {
    render(<DeliveryChip delivery={delivery({ prState: 'not_found', checksState: 'unknown', prId: null })} />);
    expect(screen.getByText('no PR found')).toBeInTheDocument();
  });

  it('renders as a link when a PR URL is known', () => {
    render(<DeliveryChip delivery={delivery({ prUrl: 'https://github.com/o/r/pull/12' })} />);
    expect(screen.getByRole('link')).toHaveAttribute('href', 'https://github.com/o/r/pull/12');
  });

  it('is a plain span (no link) without a PR URL', () => {
    render(<DeliveryChip delivery={delivery({ prUrl: null })} />);
    expect(screen.queryByRole('link')).not.toBeInTheDocument();
  });

  it('says the checks are for another commit when the PR head is not the approved head', () => {
    const { container } = render(<DeliveryChip delivery={delivery({ checksState: 'failing', headSha: 'def', approvedHeadSha: 'abc' })} />);
    expect(screen.getByText('PR #12 · checks for another commit')).toBeInTheDocument();
    expect(container.querySelector('.af-delivery.fail')).toBeNull(); // not this delivery's failure
  });

  it('shows the plain checks result when the PR head is the approved head', () => {
    render(<DeliveryChip delivery={delivery({ checksState: 'failing', headSha: 'abc', approvedHeadSha: 'abc' })} />);
    expect(screen.queryByText(/checks for another commit/)).not.toBeInTheDocument();
    expect(screen.getByText('PR #12 · checks failed')).toBeInTheDocument();
  });
  it('says "no CI by choice" when the workspace opted out of CI', () => {
    const { container } = render(<DeliveryChip delivery={delivery({ checksState: 'none', ciMode: 'none' })} />);
    expect(screen.getByText('PR #12 · no CI by choice')).toBeInTheDocument();
    expect(container.querySelector('.af-delivery.ok')).toBeTruthy();
  });

  it('still says "no checks" when the host reported none without an opt-out', () => {
    render(<DeliveryChip delivery={delivery({ checksState: 'none' })} />);
    expect(screen.getByText('PR #12 · no checks')).toBeInTheDocument();
  });
});
