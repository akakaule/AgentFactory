import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LiveView } from '../../client/src/views/LiveView.js';

vi.mock('../../client/src/api.js', () => ({
  api: { listAgents: vi.fn(), addComment: vi.fn().mockResolvedValue({}), setStatus: vi.fn().mockResolvedValue({}) },
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as {
    listAgents: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const agent = (over: Record<string, any> = {}) => ({
  key: 'AF-12', title: 'Build the thing', status: 'in_progress', workspace: 'repo-a', stage: 'implementation',
  label: 'worker-1', phase: 'running build', phaseAt: new Date().toISOString(),
  recent: [{ msg: 'running build', at: new Date().toISOString() }],
  tokensIn: 4100, tokensOut: 900, startedAt: new Date().toISOString(), heartbeatAt: new Date().toISOString(),
  ...over,
});

describe('LiveView', () => {
  it('renders a row per running agent with its current phase', async () => {
    const mocked = await getApiMock();
    mocked.listAgents.mockResolvedValue([agent()]);

    render(<LiveView onOpen={vi.fn()} />);

    expect(await screen.findByText('Build the thing')).toBeInTheDocument();
    expect(screen.getByText('AF-12')).toBeInTheDocument();
    expect(screen.getByText(/running build/)).toBeInTheDocument();
  });

  it('shows an empty state when nothing is running', async () => {
    const mocked = await getApiMock();
    mocked.listAgents.mockResolvedValue([]);

    render(<LiveView onOpen={vi.fn()} />);

    expect(await screen.findByText('No agents running')).toBeInTheDocument();
  });

  it('leaves a steering note via addComment', async () => {
    const mocked = await getApiMock();
    mocked.listAgents.mockResolvedValue([agent()]);
    const user = userEvent.setup();

    render(<LiveView onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Note' }));
    await user.type(screen.getByPlaceholderText(/Note for the next agent/), 'try the other API');
    await user.click(screen.getByRole('button', { name: 'Send note' }));

    expect(mocked.addComment).toHaveBeenCalledWith('AF-12', 'try the other API');
  });

  it('reassign re-queues the task, but only after a confirm click', async () => {
    const mocked = await getApiMock();
    mocked.listAgents.mockResolvedValue([agent()]);
    const user = userEvent.setup();

    render(<LiveView onOpen={vi.fn()} />);
    await user.click(await screen.findByRole('button', { name: 'Reassign' }));
    expect(mocked.setStatus).not.toHaveBeenCalled(); // armed, not fired

    await user.click(screen.getByRole('button', { name: 'Confirm reassign?' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-12', 'queued');
  });
});
