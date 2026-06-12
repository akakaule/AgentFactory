import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';
import type { AiReviewSummary, AiReviewFinding } from '../../client/src/types.js';

const finding = (over: Partial<AiReviewFinding> = {}): AiReviewFinding =>
  ({ severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded loop', detail: 'no cap', ...over });

const review = (over: Partial<AiReviewSummary>): AiReviewSummary =>
  ({ verdict: 'findings', findings: 0, reviewer: 'codex', items: [], ...over });

describe('ReviewActions', () => {
  it('calls onApprove when Approve is clicked (no AI review)', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={onApprove} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('approves in one click when the AI review is clean', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions aiReview={review({ verdict: 'clean', findings: 0 })} onApprove={onApprove} onRequestChanges={vi.fn()} />);
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('approves in one click while pending (no current verdict, no break-glass)', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions aiReview={review({ verdict: 'pending', findings: 2, items: [finding()] })} onApprove={onApprove} onRequestChanges={vi.fn()} />);
    expect(screen.queryByText(/recorded as an override/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('break-glass: arms a confirm before approving past open AI findings', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions aiReview={review({ verdict: 'findings', findings: 2, items: [finding(), finding({ title: 'Other' })] })} onApprove={onApprove} onRequestChanges={vi.fn()} />);

    expect(screen.getByText(/recorded as an override/i)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(onApprove).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /approve anyway/i }));
    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('renders the findings as a checklist, checked by default', () => {
    render(<ReviewActions aiReview={review({ verdict: 'findings', findings: 2, items: [finding({ title: 'Unbounded loop' }), finding({ title: 'Missing test' })] })} onApprove={vi.fn()} onRequestChanges={vi.fn()} />);
    const boxes = screen.getAllByRole('checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes.every((b) => (b as HTMLInputElement).checked)).toBe(true);
    expect(screen.getByText('Unbounded loop')).toBeInTheDocument();
    expect(screen.getByText('Missing test')).toBeInTheDocument();
  });

  it('composes an attributed body from the checked findings + the human note', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions aiReview={review({ verdict: 'findings', findings: 1, reviewer: 'codex', items: [finding({ title: 'Unbounded loop', file: 'src/x.ts', line: 42, detail: 'no cap' })] })} onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.type(screen.getByPlaceholderText(/add your own feedback/i), 'also add a test');
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    expect(onRequestChanges).toHaveBeenCalledWith('[reviewer-codex] Unbounded loop — no cap (src/x.ts:42)\n\n[human] also add a test');
  });

  it('omits an unchecked finding from the composed body', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions aiReview={review({ verdict: 'findings', findings: 2, reviewer: 'codex', items: [finding({ title: 'Keep me', file: null, line: null, detail: null }), finding({ title: 'Drop me', file: null, line: null, detail: null })] })} onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    // uncheck the second finding
    await user.click(screen.getAllByRole('checkbox')[1]!);
    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    const body = onRequestChanges.mock.calls[0]![0] as string;
    expect(body).toContain('Keep me');
    expect(body).not.toContain('Drop me');
  });

  it('shows a plain textarea and sends raw feedback when there is no AI review', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.type(screen.getByPlaceholderText('Describe what needs to change…'), 'Fix the tests');
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    expect(onRequestChanges).toHaveBeenCalledWith('Fix the tests');
  });

  it('does not send when nothing is selected and the note is empty', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Send back' }));

    expect(onRequestChanges).not.toHaveBeenCalled();
  });
});
