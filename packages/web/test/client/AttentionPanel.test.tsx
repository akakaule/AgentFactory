import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AttentionPanel } from '../../client/src/components/AttentionPanel.js';
import { api } from '../../client/src/api.js';

vi.mock('../../client/src/api.js', () => ({ api: {
  getAttention: vi.fn(), resolveAttention: vi.fn(), snoozeAttention: vi.fn(),
} }));
const occurrence = { id: 1, target: 'AF-1', taskKey: 'AF-1', text: 'Blocked: answer the question',
  resolvedAt: null, snoozedUntil: null };
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getAttention).mockResolvedValue({ occurrences: [occurrence], outbox: [
    { id: 2, occurrenceId: 1, state: 'permanently_failed', attempts: 3, maxAttempts: 3, lastError: 'webhook returned 500' },
  ] });
  vi.mocked(api.resolveAttention).mockResolvedValue({ resolved: true });
  vi.mocked(api.snoozeAttention).mockResolvedValue({ snoozed: true });
});
describe('AttentionPanel', () => {
  it('shows exhausted delivery and acknowledges the alert without changing task status', async () => {
    render(<AttentionPanel taskKey="AF-1" />);
    expect(await screen.findByText(/webhook returned 500/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
    expect(api.resolveAttention).toHaveBeenCalledWith(1);
    expect(screen.queryByText(occurrence.text)).not.toBeInTheDocument();
  });
  it('snoozes and surfaces a failed acknowledgement', async () => {
    vi.mocked(api.resolveAttention).mockRejectedValue(new Error('cannot save'));
    render(<AttentionPanel taskKey="AF-1" />);
    await userEvent.click(await screen.findByRole('button', { name: 'Snooze 1 hour' }));
    expect(api.snoozeAttention).toHaveBeenCalledWith(1, expect.any(String));
    expect(await screen.findByText(/Snoozed until/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Acknowledge alert' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('cannot save');
    expect(screen.getByText(occurrence.text)).toBeInTheDocument();
  });
  it('ignores a response for the previous task after navigation', async () => {
    let finish!: (value: Awaited<ReturnType<typeof api.getAttention>>) => void;
    vi.mocked(api.getAttention).mockReturnValueOnce(new Promise(resolve => { finish = resolve; }));
    const view = render(<AttentionPanel taskKey="AF-1" />);
    view.rerender(<AttentionPanel taskKey="AF-2" />);
    await waitFor(() => expect(api.getAttention).toHaveBeenCalledTimes(2));
    finish({ occurrences: [occurrence], outbox: [] });
    await waitFor(() => expect(screen.queryByText(occurrence.text)).not.toBeInTheDocument());
  });
});
