import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';

describe('ReviewActions', () => {
  it('calls onApprove when Approve is clicked', async () => {
    const onApprove = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={onApprove} onRequestChanges={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Approve' }));

    expect(onApprove).toHaveBeenCalledTimes(1);
  });

  it('shows feedback textarea after clicking "Request changes"', async () => {
    const user = userEvent.setup();
    render(<ReviewActions onApprove={vi.fn()} onRequestChanges={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));

    expect(screen.getByPlaceholderText('Describe what needs to change…')).toBeInTheDocument();
  });

  it('does not call onRequestChanges with empty feedback', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(onRequestChanges).not.toHaveBeenCalled();
  });

  it('calls onRequestChanges with the feedback text when non-empty', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(<ReviewActions onApprove={vi.fn()} onRequestChanges={onRequestChanges} />);

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.type(screen.getByPlaceholderText('Describe what needs to change…'), 'Fix the tests');
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(onRequestChanges).toHaveBeenCalledWith('Fix the tests');
  });
});
