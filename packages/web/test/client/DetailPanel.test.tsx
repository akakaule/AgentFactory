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
    getDiff: vi.fn().mockResolvedValue({ branch: 'task/AF-13', baseRef: 'main', diff: '', commits: 0 }),
    getTranscript: vi.fn().mockResolvedValue({ state: 'none', engine: null, attempt: null, bytes: null, blocks: [] }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    deleteAttachment: vi.fn().mockResolvedValue(undefined),
    addAttachment: vi.fn().mockResolvedValue({}),
    archive: vi.fn().mockResolvedValue({}),
    unarchive: vi.fn().mockResolvedValue({}),
    listAgents: vi.fn().mockResolvedValue([]),
  },
  eventsUrl: () => '/events',
  attachmentUrl: (id: number) => `/api/attachments/${id}`,
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

const noMetrics: TaskDetail['metrics'] = {
  queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0,
  rounds: 0, reopened: false, claimCount: 0, doneAt: null,
  model: null, tokensIn: null, tokensOut: null, costUsd: null,
};

const backlogTask: TaskDetail = {
  id: 1,
  key: 'AF-10',
  title: 'My backlog task',
  status: 'backlog',
  stage: 'implementation',
  branch: null,
  plan: null,
  spec: 'This is the spec',
  acceptanceCriteria: 'These are the acceptance criteria',
  resultSummary: null,
  seq: 1,
  workspace: 'repo-a',
  repoPath: 'c:/git/repo-a',
  claimedBy: null,
  claimedAt: null,
  archivedAt: null,
  aiReview: null,
  failure: null,
  originalSpec: null,
  originalAcceptanceCriteria: null,
  policy: null,
  verifyCommand: null,
  metrics: noMetrics,
  attachments: [],
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
      actorUserId: null,
      actorName: null,
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
      actorUserId: null,
      actorName: null,
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

const inProgressTask: TaskDetail = {
  ...backlogTask,
  id: 3,
  key: 'AF-12',
  status: 'in_progress',
  claimedBy: 'worker-1',
  claimedAt: '2024-01-01T00:00:00Z',
  activity: [],
  links: [],
};

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as {
    getTask: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    archive: ReturnType<typeof vi.fn>;
    unarchive: ReturnType<typeof vi.fn>;
    approve: ReturnType<typeof vi.fn>;
    requestChanges: ReturnType<typeof vi.fn>;
    addComment: ReturnType<typeof vi.fn>;
    updateTask: ReturnType<typeof vi.fn>;
    getDiff: ReturnType<typeof vi.fn>;
    deleteTask: ReturnType<typeof vi.fn>;
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

  it('focuses the block reason and offers Unblock on a blocked task', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    mocked.setStatus.mockResolvedValue({});
    const blockedTask: TaskDetail = {
      ...backlogTask,
      key: 'AF-17',
      status: 'blocked',
      activity: [
        { id: 1, taskId: 1, type: 'status_change', actor: 'human', fromStatus: 'backlog', toStatus: 'queued', body: '', createdAt: '2024-01-01T00:00:00Z', actorUserId: null, actorName: null },
        { id: 2, taskId: 1, type: 'status_change', actor: 'agent', fromStatus: 'queued', toStatus: 'in_progress', body: '', createdAt: '2024-01-01T00:01:00Z', actorUserId: null, actorName: null },
        { id: 3, taskId: 1, type: 'status_change', actor: 'agent', fromStatus: 'in_progress', toStatus: 'blocked', body: 'needs a DB password', createdAt: '2024-01-01T00:02:00Z', actorUserId: null, actorName: null },
      ],
    };
    mocked.getTask.mockResolvedValue(blockedTask);
    const user = userEvent.setup();

    const { container } = render(<DetailPanel taskKey="AF-17" onClose={vi.fn()} onChanged={vi.fn()} />);

    // the reason is surfaced front-and-center in the banner (it also remains in the activity log)
    await screen.findByText('Journey');
    const banner = container.querySelector('.af-blockbanner');
    expect(banner?.textContent).toContain('needs a DB password');

    await user.click(screen.getByRole('button', { name: 'Unblock → Queued' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-17', 'queued');
  });

  it('shows the claimant and a Release claim button on an in_progress task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inProgressTask);
    mocked.setStatus.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-12" onClose={vi.fn()} onChanged={vi.fn()} />);

    // claimant appears in the claim line and as Owner in the details grid
    expect((await screen.findAllByText(/worker-1/)).length).toBeGreaterThan(0);
    const release = screen.getByRole('button', { name: 'Release claim' });
    await user.click(release);
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-12', 'queued');
  });

  it('shows the AI-review chip and break-glass override on an in_review task with findings', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...inReviewTask,
      aiReview: { verdict: 'findings', findings: 2, reviewer: 'codex', items: [
        { severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded loop', detail: null },
        { severity: 'info', file: null, line: null, title: 'Missing test', detail: null },
      ] },
    });
    mocked.approve.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('AI review: 2 findings')).toBeInTheDocument();
    expect(screen.getByText(/recorded as an override/i)).toBeInTheDocument();

    // break-glass: first Approve click arms, does not approve; confirm click approves
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocked.approve).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: /approve anyway/i }));
    expect(mocked.approve).toHaveBeenCalledWith('AF-11');
  });

  it('approves a clean in_review task in one click (no override warning)', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, aiReview: { verdict: 'clean', findings: 0, reviewer: 'codex', items: [] } });
    mocked.approve.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('AI review: clean')).toBeInTheDocument();
    expect(screen.queryByText(/recorded as an override/i)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocked.approve).toHaveBeenCalledWith('AF-11');
  });

  it('shows no Release claim button outside in_progress', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inReviewTask);

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('Implementation complete');
    expect(screen.queryByRole('button', { name: 'Release claim' })).not.toBeInTheDocument();
  });

  it('renders the workspace and repo path', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    // workspace shows in the drawer head badge and the details grid
    expect((await screen.findAllByText('repo-a')).length).toBeGreaterThan(0);
    expect(screen.getByText('c:/git/repo-a')).toBeInTheDocument();
  });

  it('renders the "Queue task" button for a backlog task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Queue task' })).toBeInTheDocument();
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

  it('renders spec image thumbnails linking to the binary route', async () => {
    const mocked = await getApiMock();
    const withImage: TaskDetail = {
      ...backlogTask,
      key: 'AF-16',
      attachments: [{ id: 9, taskId: 1, filename: 'mock.png', mime: 'image/png', size: 123 }],
    };
    mocked.getTask.mockResolvedValue(withImage);

    render(<DetailPanel taskKey="AF-16" onClose={vi.fn()} onChanged={vi.fn()} />);

    const img = await screen.findByAltText('mock.png');
    expect(img).toHaveAttribute('src', '/api/attachments/9');
    expect(img.closest('a')).toHaveAttribute('href', '/api/attachments/9');
  });

  it('renders the Metrics strip with reported usage', async () => {
    const mocked = await getApiMock();
    const reported: TaskDetail = {
      ...inReviewTask,
      key: 'AF-15',
      metrics: {
        ...noMetrics, claimCount: 1, queueMin: 12, workMin: 38, reviewMin: 66,
        model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92,
      },
    };
    mocked.getTask.mockResolvedValue(reported);

    render(<DetailPanel taskKey="AF-15" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Metrics')).toBeInTheDocument();
    expect(screen.getByText('41k')).toBeInTheDocument();
    expect(screen.getByText('claude-fable-5')).toBeInTheDocument();
  });

  it('shows the no-metrics line for an unworked task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText(/hasn't been worked/)).toBeInTheDocument();
  });

  it('shows a Reopen button on a done task and re-queues on click', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    const doneTask: TaskDetail = { ...inReviewTask, key: 'AF-14', status: 'done' };
    mocked.getTask.mockResolvedValue(doneTask);
    mocked.setStatus.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-14" onClose={vi.fn()} onChanged={vi.fn()} />);

    const reopen = await screen.findByRole('button', { name: 'Reopen' });
    await user.click(reopen);
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-14', 'queued');
  });

  it('shows no Reopen button outside done', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inReviewTask);

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('Implementation complete');
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
  });

  it('shows an Archive button on a done task and archives on click', async () => {
    const mocked = await getApiMock();
    mocked.archive.mockClear();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, key: 'AF-14', status: 'done' });
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-14" onClose={vi.fn()} onChanged={vi.fn()} />);

    const archive = await screen.findByRole('button', { name: 'Archive' });
    await user.click(archive);
    expect(mocked.archive).toHaveBeenCalledWith('AF-14');
  });

  it('shows no Archive button outside done', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inReviewTask);

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('Implementation complete');
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();
  });

  it('marks an archived task and offers Unarchive instead of Reopen or Archive', async () => {
    const mocked = await getApiMock();
    mocked.unarchive.mockClear();
    mocked.getTask.mockResolvedValue({
      ...inReviewTask, key: 'AF-14', status: 'done', archivedAt: '2026-06-01T00:00:00Z',
    });
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-14" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Archived')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reopen' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Archive' })).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Unarchive' }));
    expect(mocked.unarchive).toHaveBeenCalledWith('AF-14');
  });

  it('renders a Changes section for a task with a branch link', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockClear();
    const branchTask: TaskDetail = {
      ...inReviewTask,
      key: 'AF-13',
      links: [{ id: 2, taskId: 2, kind: 'branch', label: 'task/AF-13', url: 'https://example.com/b' }],
    };
    mocked.getTask.mockResolvedValue(branchTask);

    render(<DetailPanel taskKey="AF-13" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Changes')).toBeInTheDocument();
    await waitFor(() => expect(mocked.getDiff).toHaveBeenCalledWith('AF-13'));
  });

  it('shows no Changes section without a branch link', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockClear();
    mocked.getTask.mockResolvedValue(backlogTask); // pr link only

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('This is the spec');
    expect(screen.queryByText('Changes')).not.toBeInTheDocument();
    expect(mocked.getDiff).not.toHaveBeenCalled();
  });

  it('deletes a task through the two-step confirm and closes the panel', async () => {
    const mocked = await getApiMock();
    mocked.deleteTask.mockClear();
    mocked.getTask.mockResolvedValue(backlogTask);
    const onClose = vi.fn();
    const onChanged = vi.fn();
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-10" onClose={onClose} onChanged={onChanged} />);

    const del = await screen.findByRole('button', { name: 'Delete task' });
    await user.click(del);
    // first click only arms — nothing deleted yet
    expect(mocked.deleteTask).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Confirm delete?' }));
    expect(mocked.deleteTask).toHaveBeenCalledWith('AF-10');
    await waitFor(() => {
      expect(onChanged).toHaveBeenCalled();
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('hides the delete button on an in_progress task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inProgressTask);

    render(<DetailPanel taskKey="AF-12" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByRole('button', { name: 'Release claim' });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it('shows the delivery section with Mark done / Re-queue on a delivering task', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    mocked.setStatus.mockResolvedValue({});
    const deliveringTask: TaskDetail = {
      ...inReviewTask,
      key: 'AF-21',
      status: 'delivering',
      delivery: {
        provider: 'github', branch: 'feature/AF-21-x', prUrl: 'https://github.com/o/r/pull/21', prId: '21',
        prState: 'open', checksState: 'failing',
        failing: [{ name: 'unit-tests', url: 'https://ci/run/1' }],
        checkedAt: '2026-07-02T00:00:00Z', stateChangedAt: '2026-07-02T00:00:00Z',
      },
    };
    mocked.getTask.mockResolvedValue(deliveringTask);
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-21" onClose={vi.fn()} onChanged={vi.fn()} />);

    // the chip and the failing-check link both render
    expect(await screen.findByText('PR #21 · checks failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'unit-tests' })).toHaveAttribute('href', 'https://ci/run/1');

    await user.click(screen.getByRole('button', { name: 'Re-queue' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-21', 'queued');

    await user.click(screen.getByRole('button', { name: 'Mark done' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-21', 'done');
  });

  it('calls onClose when the close button is clicked', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);
    const onClose = vi.fn();
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-10" onClose={onClose} onChanged={vi.fn()} />);
    await screen.findByText('This is the spec');

    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onClose).toHaveBeenCalled();
  });

  it('refetches the panel and calls onChanged after "Queue task"', async () => {
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
    const releaseButton = await screen.findByRole('button', { name: 'Queue task' });
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
