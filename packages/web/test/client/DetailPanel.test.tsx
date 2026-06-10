import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '../../client/src/components/DetailPanel.js';
import type { TaskDetail } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({}),
    setStatus: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    addComment: vi.fn().mockResolvedValue({}),
  },
}));

// Safe EventSource stub for DetailPanel (uses useEventStream internally)
beforeEach(() => {
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
    get onerror() { return null; },
    set onerror(_fn: unknown) {},
  })) as unknown as typeof EventSource;
});

const backlogTask: TaskDetail = {
  id: 1,
  key: 'AF-10',
  title: 'My backlog task',
  status: 'backlog',
  spec: 'This is the spec',
  acceptanceCriteria: 'These are the acceptance criteria',
  resultSummary: null,
  seq: 1,
  workspace: 'repo-a',
  repoPath: 'c:/git/repo-a',
  createdAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
  activity: [
    {
      id: 1,
      taskId: 1,
      type: 'status_change',
      actor: 'human',
      fromStatus: null,
      toStatus: 'backlog',
      body: '',
      createdAt: '2024-01-01T00:00:00Z',
    },
    {
      id: 2,
      taskId: 1,
      type: 'comment',
      actor: 'human',
      fromStatus: null,
      toStatus: null,
      body: 'A comment here',
      createdAt: '2024-01-01T00:00:00Z',
    },
  ],
  links: [
    { id: 1, taskId: 1, kind: 'pr', label: 'PR #42', url: 'https://example.com/pr/42' },
  ],
};

const inReviewTask: TaskDetail = {
  ...backlogTask,
  id: 2,
  key: 'AF-11',
  status: 'in_review',
  resultSummary: 'Implementation complete',
  activity: [],
  links: [],
};

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as {
    getTask: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    requestChanges: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
  };
}

describe('DetailPanel', () => {
  it('renders spec, acceptance criteria, links, and activity', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('This is the spec')).toBeInTheDocument();
    expect(screen.getByText('These are the acceptance criteria')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'PR #42' })).toHaveAttribute('href', 'https://example.com/pr/42');
    expect(screen.getByText('A comment here')).toBeInTheDocument();
  });

  it('renders the workspace and repo path', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('repo-a')).toBeInTheDocument();
    expect(screen.getByText('c:/git/repo-a')).toBeInTheDocument();
  });

  it('renders the "Release to Queued" button for a backlog task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Release to Queued' })).toBeInTheDocument();
  });

  it('renders ReviewActions for an in_review task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inReviewTask);

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request changes' })).toBeInTheDocument();
  });

  it('renders resultSummary when set', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inReviewTask);

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Implementation complete')).toBeInTheDocument();
  });

  it('does NOT render ReviewActions for a backlog task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    // Wait for render
    await screen.findByText('This is the spec');
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
  });

  it('calls onClose when the close button is clicked', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-10" onClose={onClose} onChanged={vi.fn()} />);
    await screen.findByText('This is the spec');

    await user.click(screen.getByRole('button', { name: '✕' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('refetches the panel and calls onChanged after "Release to Queued"', async () => {
    const mocked = await getApiMock();
    const queuedTask: TaskDetail = { ...backlogTask, status: 'queued' };
    mocked.getTask.mockClear();
    mocked.setStatus.mockClear();
    mocked.getTask.mockResolvedValue(backlogTask);
    mocked.setStatus.mockResolvedValue(queuedTask);
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={onChanged} />);

    // Initial load — one getTask call for the mount fetch.
    const releaseButton = await screen.findByRole('button', { name: 'Release to Queued' });
    const callsAfterMount = mocked.getTask.mock.calls.length;
    expect(callsAfterMount).toBe(1);

    await user.click(releaseButton);

    // setStatus called with the task key and the 'queued' target.
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-10', 'queued');

    // After the mutation resolves, the panel refetches AND onChanged fires.
    await waitFor(() => {
      expect(mocked.getTask.mock.calls.length).toBeGreaterThan(callsAfterMount);
      expect(onChanged).toHaveBeenCalledTimes(1);
    });
  });
});
