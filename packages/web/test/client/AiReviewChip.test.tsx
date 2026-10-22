import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AiReviewChip } from '../../client/src/components/AiReviewChip.js';
import { af146Brief, v1Brief } from './fixtures/reviewBrief.js';

describe('AiReviewChip', () => {
  it('renders nothing when no AI review is present', () => {
    const { container } = render(<AiReviewChip brief={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['changes needed', af146Brief(), 'Changes needed', '2 must fix · 3 your call', 'changes_needed'],
    ['your call', { ...af146Brief(), headline: 'your_call' as const }, 'Your call · 3', null, 'your_call'],
    ['minor', v1Brief([{ severity: 'warning', file: null, line: null, title: 'Slow', detail: null }]), 'Minor issues · 1', null, 'minor'],
    ['clean', v1Brief([]), 'No issues found', null, 'clean'],
    ['pending', af146Brief({ superseded: true }), 'Review pending', null, 'pending'],
  ])('%s: label, the text beside it, its colour class and the verdict sentence as the tooltip', (_, brief, label, detail, cls) => {
    const { container } = render(<AiReviewChip brief={brief} />);
    const chip = screen.getByText(label).closest('.af-rv-chip')!;
    expect(chip).toHaveClass(cls);
    expect(chip.getAttribute('title')).toMatch(/\.$/); // the sentence
    if (detail) expect(screen.getByText(detail)).toBeInTheDocument();
    else expect(container.querySelector('.af-rv-chipdetail')).toBeNull();
  });
});
