import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiReviewChip } from '../../client/src/components/AiReviewChip.js';

describe('AiReviewChip', () => {
  it('renders nothing when no AI review is present', () => {
    const { container } = render(<AiReviewChip review={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows a clean verdict at zero findings', () => {
    render(<AiReviewChip review={{ findings: 0 }} />);
    expect(screen.getByText('AI review: clean')).toBeInTheDocument();
  });

  it('pluralizes findings correctly', () => {
    render(<AiReviewChip review={{ findings: 1 }} />);
    expect(screen.getByText('AI review: 1 finding')).toBeInTheDocument();
  });

  it('shows the findings count', () => {
    render(<AiReviewChip review={{ findings: 3 }} />);
    expect(screen.getByText('AI review: 3 findings')).toBeInTheDocument();
  });
});
