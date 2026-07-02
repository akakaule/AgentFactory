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

  it('shows a merged PR as verifying', () => {
    render(<DeliveryChip delivery={delivery({ prState: 'merged', checksState: 'passing' })} />);
    expect(screen.getByText('PR #12 merged · verifying')).toBeInTheDocument();
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
});
