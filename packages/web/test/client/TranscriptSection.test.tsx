import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TranscriptSection } from '../../client/src/components/TranscriptSection.js';
import type { TranscriptResponse } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: { getTranscript: vi.fn() },
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { getTranscript: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  (await getApiMock()).getTranscript.mockReset();
});

const finalRes: TranscriptResponse = {
  state: 'final', engine: 'claude', attempt: 1, bytes: 2048,
  blocks: [
    { id: 'a:0', role: 'assistant', at: null, sidechain: false, kind: 'text', text: 'Hello from the agent' },
    { id: 'b:0', role: 'assistant', at: null, sidechain: false, kind: 'bash', command: 'npm test', description: null, stdout: 'all passing', stderr: null, exitCode: 0, isError: false, truncated: false },
  ],
};

describe('TranscriptSection', () => {
  it('shows a compact summary + a View button, with the blocks NOT inline', async () => {
    const mocked = await getApiMock();
    mocked.getTranscript.mockResolvedValue(finalRes);

    render(<TranscriptSection taskKey="AF-7" status="done" />);

    expect(await screen.findByText('2 blocks')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'View transcript' })).toBeInTheDocument();
    // de-emphasized: the block content stays hidden until the modal is opened
    expect(screen.queryByText('Hello from the agent')).not.toBeInTheDocument();
    expect(mocked.getTranscript).toHaveBeenCalledWith('AF-7');
  });

  it('opens a modal with the full blocks when View transcript is clicked', async () => {
    const mocked = await getApiMock();
    mocked.getTranscript.mockResolvedValue(finalRes);
    const user = userEvent.setup();

    render(<TranscriptSection taskKey="AF-7" status="done" />);
    await user.click(await screen.findByRole('button', { name: 'View transcript' }));

    expect(screen.getByRole('dialog', { name: 'Agent transcript' })).toBeInTheDocument();
    expect(screen.getByText('Hello from the agent')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
  });

  it('renders nothing when state is none', async () => {
    const mocked = await getApiMock();
    mocked.getTranscript.mockResolvedValue({ state: 'none', engine: null, attempt: null, bytes: null, blocks: [] });

    const { container } = render(<TranscriptSection taskKey="AF-8" status="backlog" />);

    await waitFor(() => expect(mocked.getTranscript).toHaveBeenCalledWith('AF-8'));
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
    expect(container.querySelector('.af-tx-row')).toBeNull();
  });
});
