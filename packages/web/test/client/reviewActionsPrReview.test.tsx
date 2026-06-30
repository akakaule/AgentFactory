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

  it('pre-fills the review body with the AI findings as editable markdown and copies it verbatim', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" aiReview={withFinding} />);
    const ta = screen.getByPlaceholderText(/paste this onto the PR/i) as HTMLTextAreaElement;
    expect(ta.value).toBe('- **Unbounded loop** — no cap (`src/x.ts:42`) _warning_');

    fireEvent.click(screen.getByRole('button', { name: /Copy review for the PR/i }));
    expect(writeText).toHaveBeenCalledWith('- **Unbounded loop** — no cap (`src/x.ts:42`) _warning_');
  });

  it('copies the human-edited review verbatim', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" aiReview={withFinding} />);
    fireEvent.change(screen.getByPlaceholderText(/paste this onto the PR/i), { target: { value: 'LGTM, one nit:\n\n- fix the guard' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy review for the PR/i }));
    expect(writeText).toHaveBeenCalledWith('LGTM, one nit:\n\n- fix the guard');
  });

  it('disables the copy button when there is nothing to copy (no findings, no note)', () => {
    render(<ReviewActions onApprove={noop} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" />);
    expect(screen.getByRole('button', { name: /Copy review for the PR/i })).toBeDisabled();
  });

  it('"Mark reviewed" sends the edited review body to onMarkReviewed (not onApprove)', () => {
    const onMarkReviewed = vi.fn();
    const onApprove = vi.fn();
    // no open findings, so "Mark reviewed" fires in one click (no break-glass arming step)
    render(<ReviewActions onApprove={onApprove} onMarkReviewed={onMarkReviewed} onRequestChanges={vi.fn()} stage="implementation" kind="pr-review" />);
    fireEvent.change(screen.getByPlaceholderText(/paste this onto the PR/i), { target: { value: 'LGTM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(onMarkReviewed).toHaveBeenCalledWith('LGTM');
    expect(onApprove).not.toHaveBeenCalled();
  });
});
