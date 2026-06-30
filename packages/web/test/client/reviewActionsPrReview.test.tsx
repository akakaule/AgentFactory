import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';
import type { AiReviewSummary } from '../../client/src/types.js';

const noop = () => {};

const withFinding: AiReviewSummary = {
  verdict: 'findings', findings: 1, reviewer: 'codex',
  items: [{ severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded loop', detail: 'no cap' }],
};

describe('ReviewActions — pr-review kind', () => {
  it('shows "Mark reviewed" and no "Request changes" for a pr-review task', () => {
    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" />);
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
  });

  it('keeps the normal Approve + Request changes for a code task', () => {
    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="code" />);
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument();
  });

  it('copies the curated review (note + checked findings) for the PR as clean markdown', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" aiReview={withFinding} />);
    fireEvent.change(screen.getByPlaceholderText(/paste this onto the PR/i), { target: { value: 'Two things below.' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy review for the PR/i }));

    expect(writeText).toHaveBeenCalledWith(
      'Two things below.\n\n- **Unbounded loop** — no cap (`src/x.ts:42`) _warning_',
    );
  });

  it('disables the copy button when there is nothing to copy (no findings, no note)', () => {
    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" />);
    expect(screen.getByRole('button', { name: /Copy review for the PR/i })).toBeDisabled();
  });
});
