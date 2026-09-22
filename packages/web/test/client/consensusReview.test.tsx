import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AiReviewSummary, ReviewConsensus } from '@agentfactory/core';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';
import { AiReviewChip } from '../../client/src/components/AiReviewChip.js';

const finding = { title: 'Agreed bug', severity: 'error' as const, file: 'a.ts', line: 1, detail: 'Proof' };
const consensus: ReviewConsensus = {
  participants: ['claude/fable', 'codex/astra'], status: 'disputed', history: [{ phase: 'discovery', reviewer: 'claude/fable', body: 'Original review evidence' }],
  candidates: [{ id: 'F2', source: 'claude/fable', finding: { ...finding, title: 'Disputed bug' }, outcome: 'disputed', votes: [
    { reviewer: 'claude/fable', decision: 'confirm', severity: 'error', evidence: 'I reproduced it', duplicateOf: null },
    { reviewer: 'codex/astra', decision: 'reject', severity: 'error', evidence: 'Guard prevents it', duplicateOf: null },
  ] }],
};
const review: AiReviewSummary = { verdict: 'disputed', findings: 1, reviewer: 'claude/fable + codex/astra', items: [finding], consensus };
describe('consensus review presentation', () => {
  it('distinguishes agreed high-priority findings from disputes in the chip', () => {
    render(<AiReviewChip review={review} />);
    expect(screen.getByText('AI review: 1 agreed high-priority · 1 disputed')).toBeInTheDocument();
  });
  it('shows evidence in collapsed disputes and sends only agreed findings', async () => {
    const send = vi.fn(); const user = userEvent.setup();
    render(<ReviewActions aiReview={review} onApprove={vi.fn()} onRequestChanges={send} />);
    expect(screen.getAllByRole('checkbox')).toHaveLength(1);
    expect(screen.getByText('Confirmed by all 2 reviewers')).toBeInTheDocument();
    const summary = screen.getByText('Needs human decision · 1 disputed finding');
    expect(summary.closest('details')).not.toHaveAttribute('open');
    await user.click(summary);
    expect(screen.getByText('Guard prevents it')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));
    expect(send.mock.calls[0]?.[0]).toContain('Agreed bug');
    expect(send.mock.calls[0]?.[0]).not.toContain('Disputed bug');
  });
  it('requires explicit override for disputed-only results', async () => {
    const approve = vi.fn(); const user = userEvent.setup();
    render(<ReviewActions aiReview={{ ...review, items: [], findings: 0 }} onApprove={approve} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /approve anyway/ }));
    expect(approve).toHaveBeenCalledOnce();
  });
});
