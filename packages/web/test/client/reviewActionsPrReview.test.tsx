import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ReviewActions } from '../../client/src/components/ReviewActions.js';

const noop = () => {};

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
});
