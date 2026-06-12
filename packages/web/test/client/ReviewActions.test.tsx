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

  it('prepends line-anchored drafts to the free-text feedback', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewActions
        onApprove={vi.fn()}
        onRequestChanges={onRequestChanges}
        comments={[
          { file: 'src/app.ts', line: 42, text: 'this cap should be configurable' },
          { file: 'README.md', line: 7, text: 'typo' },
        ]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.type(screen.getByPlaceholderText('Describe what needs to change…'), 'also rebase');
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(onRequestChanges).toHaveBeenCalledWith(
      'src/app.ts:42 - "this cap should be configurable"\n' +
        'README.md:7 - "typo"\n' +
        'also rebase',
    );
  });

  it('submits drafts alone even when the textarea is empty', async () => {
    const onRequestChanges = vi.fn();
    const user = userEvent.setup();
    render(
      <ReviewActions
        onApprove={vi.fn()}
        onRequestChanges={onRequestChanges}
        comments={[{ file: 'a.ts', line: 1, text: 'fix' }]}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'Request changes' }));
    await user.click(screen.getByRole('button', { name: 'Submit feedback' }));

    expect(onRequestChanges).toHaveBeenCalledWith('a.ts:1 - "fix"');
  });
});
