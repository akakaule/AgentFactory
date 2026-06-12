import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiReviewChip } from '../../client/src/components/AiReviewChip.js';
import type { AiReviewSummary } from '../../client/src/types.js';

const review = (over: Partial<AiReviewSummary>): AiReviewSummary =>
  ({ verdict: 'clean', findings: 0, reviewer: 'codex', items: [], ...over });

describe('AiReviewChip', () => {
  it('renders nothing when no AI review is present', () => {
    const { container } = render(<AiReviewChip review={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a clean verdict at zero findings', () => {
    render(<AiReviewChip review={review({ verdict: 'clean', findings: 0 })} />);
    expect(screen.getByText('AI review: clean')).toBeInTheDocument();
  });

  it('pluralizes findings correctly', () => {
    render(<AiReviewChip review={review({ verdict: 'findings', findings: 1 })} />);
    expect(screen.getByText('AI review: 1 finding')).toBeInTheDocument();
  });

  it('shows the findings count', () => {
    render(<AiReviewChip review={review({ verdict: 'findings', findings: 3 })} />);
    expect(screen.getByText('AI review: 3 findings')).toBeInTheDocument();
  });

  it('shows pending when a newer result awaits re-review', () => {
    render(<AiReviewChip review={review({ verdict: 'pending', findings: 2 })} />);
    expect(screen.getByText('AI review: pending')).toBeInTheDocument();
  });
});
