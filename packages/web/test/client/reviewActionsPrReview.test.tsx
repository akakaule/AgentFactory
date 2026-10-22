import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';
import type { AiReviewSummary } from '../../client/src/types.js';

const noop = () => {};

const withFinding: AiReviewSummary = {
  verdict: 'findings', findings: 1, reviewer: 'codex',
  items: [{ severity: 'error', file: 'src/x.ts', line: 42, title: 'Unbounded loop', detail: 'no cap' }],
};

describe('ReviewActions — pr-review tasks', () => {
  it('shows "Mark reviewed" and no "Request changes" for a pr-review task', () => {
    render(<ReviewActions onMarkReviewed={noop} />);
    expect(screen.getByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Request changes' })).not.toBeInTheDocument();
  });

  it('pre-fills the review body with the AI findings as editable markdown and copies it verbatim', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ReviewActions onMarkReviewed={noop} aiReview={withFinding} />);
    const ta = screen.getByPlaceholderText(/paste this onto the PR/i) as HTMLTextAreaElement;
    expect(ta.value).toBe('- **Unbounded loop** — no cap (`src/x.ts:42`) _error_');

    fireEvent.click(screen.getByRole('button', { name: /Copy review for the PR/i }));
    expect(writeText).toHaveBeenCalledWith('- **Unbounded loop** — no cap (`src/x.ts:42`) _error_');
  });

  it('copies the human-edited review verbatim', () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<ReviewActions onMarkReviewed={noop} aiReview={withFinding} />);
    fireEvent.change(screen.getByPlaceholderText(/paste this onto the PR/i), { target: { value: 'LGTM, one nit:\n\n- fix the guard' } });
    fireEvent.click(screen.getByRole('button', { name: /Copy review for the PR/i }));
    expect(writeText).toHaveBeenCalledWith('LGTM, one nit:\n\n- fix the guard');
  });

  it('disables the copy button when there is nothing to copy (no findings, no note)', () => {
    render(<ReviewActions onMarkReviewed={noop} />);
    expect(screen.getByRole('button', { name: /Copy review for the PR/i })).toBeDisabled();
  });

  it('"Mark reviewed" sends the edited review body', () => {
    const onMarkReviewed = vi.fn();
    // no open findings, so "Mark reviewed" fires in one click (no break-glass arming step)
    render(<ReviewActions onMarkReviewed={onMarkReviewed} />);
    fireEvent.change(screen.getByPlaceholderText(/paste this onto the PR/i), { target: { value: 'LGTM' } });
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(onMarkReviewed).toHaveBeenCalledWith('LGTM');
  });

  it('marking reviewed over open findings takes a second, explicit click', () => {
    const onMarkReviewed = vi.fn();
    render(<ReviewActions onMarkReviewed={onMarkReviewed} aiReview={withFinding} />);
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed' }));
    expect(onMarkReviewed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Mark reviewed anyway (1)' }));
    expect(onMarkReviewed).toHaveBeenCalledWith('- **Unbounded loop** — no cap (`src/x.ts:42`) _error_');
  });
});
