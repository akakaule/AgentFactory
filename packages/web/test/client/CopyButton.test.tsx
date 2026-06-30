import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CopyButton } from '../../client/src/components/CopyButton.js';

describe('CopyButton', () => {
  it('is disabled when the body is empty', () => {
    render(<CopyButton body="" label="Copy" />);
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled();
  });

  it('copies the body and flashes "Copied ✓"', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<CopyButton body="hello world" label="Copy" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith('hello world');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied ✓' })).toBeInTheDocument());
  });
});
