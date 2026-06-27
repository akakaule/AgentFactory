import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

describe('TranscriptSection', () => {
  it('renders block text and a bash command for a final transcript', async () => {
    const mocked = await getApiMock();
    const res: TranscriptResponse = {
      state: 'final', engine: 'claude', attempt: 1, bytes: 2048,
      blocks: [
        { id: 'a:0', role: 'assistant', at: null, sidechain: false, kind: 'text', text: 'Hello from the agent' },
        { id: 'b:0', role: 'assistant', at: null, sidechain: false, kind: 'bash', command: 'npm test', description: null, stdout: 'all passing', stderr: null, exitCode: 0, isError: false, truncated: false },
      ],
    };
    mocked.getTranscript.mockResolvedValue(res);

    render(<TranscriptSection taskKey="AF-7" status="done" />);

    expect(await screen.findByText('Hello from the agent')).toBeInTheDocument();
    expect(screen.getByText('npm test')).toBeInTheDocument();
    expect(screen.getByText('2 blocks')).toBeInTheDocument();
    expect(mocked.getTranscript).toHaveBeenCalledWith('AF-7');
  });

  it('renders nothing when state is none', async () => {
    const mocked = await getApiMock();
    mocked.getTranscript.mockResolvedValue({ state: 'none', engine: null, attempt: null, bytes: null, blocks: [] });

    const { container } = render(<TranscriptSection taskKey="AF-8" status="backlog" />);

    await waitFor(() => expect(mocked.getTranscript).toHaveBeenCalledWith('AF-8'));
    expect(screen.queryByText('Transcript')).not.toBeInTheDocument();
    expect(container.querySelector('.af-tx')).toBeNull();
  });
});
