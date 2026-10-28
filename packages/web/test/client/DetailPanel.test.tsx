import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DetailPanel } from '../../client/src/components/DetailPanel.js';
import type { TaskDetail } from '../../client/src/types.js';
import { v1Brief } from './fixtures/reviewBrief.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAttention: vi.fn().mockResolvedValue({ occurrences: [], outbox: [] }),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn().mockResolvedValue({}),
    addTaskDependency: vi.fn().mockResolvedValue({}),
    removeTaskDependency: vi.fn().mockResolvedValue({}),
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
    restart: vi.fn().mockResolvedValue({}),
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
  queueMin: 0, workMin: 0, reviewMin: 0, blockedMin: 0, deliveringMin: 0,
  rounds: 0, reopened: false, claimCount: 0, doneAt: null,
  model: null, tokensIn: null, tokensOut: null, costUsd: null,
};

type DependencySummary = Pick<TaskDetail, 'key' | 'title' | 'status' | 'workspace'>;
type DependencyAwareTaskDetail = TaskDetail & {
  dependencies: DependencySummary[];
  dependents: DependencySummary[];
  unmetDependencyCount: number;
};

const backlogTask: DependencyAwareTaskDetail = {
  id: 1,
  key: 'AF-10',
  title: 'My backlog task',
  status: 'backlog',
  stage: 'implementation',
  kind: 'code',
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
  delivery: null,
  unmetDependencyCount: 0,
  dependencies: [],
  dependents: [],
  originalSpec: null,
  originalAcceptanceCriteria: null,
  policy: null,
  verifyCommand: null,
  hasVisualization: false,
  visualizationGeneratedAt: null,
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
    addTaskDependency: ReturnType<typeof vi.fn>;
    removeTaskDependency: ReturnType<typeof vi.fn>;
    restart: ReturnType<typeof vi.fn>;
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

  it('links to the task from the drawer header and copies its absolute URL', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(screen.getByRole('link', { name: 'AF-10' })).toHaveAttribute('href', '#task=AF-10');
    await userEvent.click(screen.getByRole('button', { name: 'Copy link' }));
    const { origin, pathname, search } = window.location;
    expect(writeText).toHaveBeenCalledWith(`${origin}${pathname}${search}#task=AF-10`);
    expect(await screen.findByRole('button', { name: 'Copied ✓' })).toBeInTheDocument();
  });

  it('shows both dependency directions and navigates to a linked task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...backlogTask,
      dependencies: [
        { key: 'AF-1', title: 'Foundation API', status: 'done', workspace: 'repo-a' },
      ],
      dependents: [
        { key: 'AF-12', title: 'Consumer UI', status: 'queued', workspace: 'repo-b' },
      ],
    });
    const onOpenTask = vi.fn();
    const user = userEvent.setup();

    render(
      <DetailPanel
        taskKey="AF-10"
        tasks={[]}
        onOpenTask={onOpenTask}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    expect(await screen.findByText('Depends on')).toBeInTheDocument();
    expect(screen.getByText('Blocks')).toBeInTheDocument();
    expect(screen.getByText('Foundation API')).toBeInTheDocument();
    expect(screen.getByText('Consumer UI')).toBeInTheDocument();
    expect(screen.getByText('repo-b')).toBeInTheDocument();
    expect(screen.getByText('Done')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /AF-1.*Foundation API/i }));
    expect(onOpenTask).toHaveBeenCalledWith('AF-1');
  });

  it('ignores an older detail response after navigating to another task', async () => {
    const mocked = await getApiMock();
    let resolveOld!: (task: TaskDetail) => void;
    let resolveNew!: (task: TaskDetail) => void;
    const oldRequest = new Promise<TaskDetail>((resolve) => { resolveOld = resolve; });
    const newRequest = new Promise<TaskDetail>((resolve) => { resolveNew = resolve; });
    mocked.getTask.mockImplementation((key: string) => key === 'AF-10' ? oldRequest : newRequest);

    const props = { tasks: [], onOpenTask: vi.fn(), onClose: vi.fn(), onChanged: vi.fn() };
    const { rerender } = render(<DetailPanel taskKey="AF-10" {...props} />);
    rerender(<DetailPanel taskKey="AF-11" {...props} />);

    await act(async () => {
      resolveNew({ ...backlogTask, id: 2, key: 'AF-11', title: 'New task' });
      await newRequest;
    });
    expect(screen.getByRole('heading', { name: 'New task' })).toBeInTheDocument();

    await act(async () => {
      resolveOld({ ...backlogTask, title: 'Old task' });
      await oldRequest;
    });
    expect(screen.getByRole('heading', { name: 'New task' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Old task' })).not.toBeInTheDocument();
  });

  it('searches all active tasks across workspaces and excludes self and existing dependencies', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...backlogTask,
      dependencies: [
        { key: 'AF-1', title: 'Existing prerequisite', status: 'backlog', workspace: 'repo-a' },
      ],
    });
    mocked.addTaskDependency.mockClear();
    mocked.addTaskDependency.mockResolvedValue({});
    const onChanged = vi.fn();
    const user = userEvent.setup();
    const tasks = [
      { ...backlogTask, key: 'AF-10', title: 'Current task' },
      { ...backlogTask, key: 'AF-1', title: 'Existing prerequisite' },
      { ...backlogTask, id: 2, key: 'AF-2', title: 'Shared API', workspace: 'repo-b' },
    ];

    render(
      <DetailPanel
        taskKey="AF-10"
        tasks={tasks}
        onOpenTask={vi.fn()}
        onClose={vi.fn()}
        onChanged={onChanged}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Add dependency' }));
    await user.type(screen.getByLabelText('Search tasks to depend on'), 'repo-b');

    expect(screen.queryByRole('button', { name: /Add AF-10/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Add AF-1 /i })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Add AF-2.*Shared API/i }));

    expect(mocked.addTaskDependency).toHaveBeenCalledWith('AF-10', 'AF-2');
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('removes links in dependent-first order from either relationship direction', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...backlogTask,
      dependencies: [
        { key: 'AF-1', title: 'Foundation API', status: 'in_review', workspace: 'repo-a' },
      ],
      dependents: [
        { key: 'AF-12', title: 'Consumer UI', status: 'queued', workspace: 'repo-b' },
        { key: 'AF-13', title: 'Already running', status: 'in_progress', workspace: 'repo-b' },
      ],
    });
    mocked.removeTaskDependency.mockClear();
    mocked.removeTaskDependency.mockResolvedValue({});
    const user = userEvent.setup();

    render(
      <DetailPanel
        taskKey="AF-10"
        tasks={[]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Remove dependency AF-1' }));
    await user.click(screen.getByRole('button', { name: 'Remove dependent AF-12' }));

    expect(mocked.removeTaskDependency).toHaveBeenNthCalledWith(1, 'AF-10', 'AF-1');
    expect(mocked.removeTaskDependency).toHaveBeenNthCalledWith(2, 'AF-12', 'AF-10');
    expect(screen.queryByRole('button', { name: 'Remove dependent AF-13' })).not.toBeInTheDocument();
  });

  it('keeps dependency mutation errors visible and the picker usable', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);
    mocked.addTaskDependency.mockClear();
    mocked.addTaskDependency.mockRejectedValue(new Error('dependency would create a cycle'));
    const user = userEvent.setup();

    render(
      <DetailPanel
        taskKey="AF-10"
        tasks={[{ ...backlogTask, id: 2, key: 'AF-2', title: 'Other task', workspace: 'repo-b' }]}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Add dependency' }));
    await user.type(screen.getByLabelText('Search tasks to depend on'), 'AF-2');
    await user.click(screen.getByRole('button', { name: /Add AF-2/i }));

    expect(await screen.findByText('dependency would create a cycle')).toBeInTheDocument();
    expect(screen.getByLabelText('Search tasks to depend on')).toBeInTheDocument();
  });

  it('keeps Queue task enabled while explaining unmet dependencies', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...backlogTask,
      unmetDependencyCount: 1,
      dependencies: [
        { key: 'AF-1', title: 'Foundation API', status: 'in_progress', workspace: 'repo-a' },
      ],
    });

    render(<DetailPanel taskKey="AF-10" tasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByText('Waiting on 1 dependency')).toBeInTheDocument();
    expect(screen.getByText(/can be queued now and starts automatically/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Queue task' })).toBeEnabled();
  });

  it('does not describe already-started work as waiting when a prerequisite is reopened', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...inProgressTask,
      unmetDependencyCount: 1,
      dependencies: [
        { key: 'AF-1', title: 'Reopened prerequisite', status: 'queued', workspace: 'repo-a' },
      ],
    });

    render(<DetailPanel taskKey="AF-12" tasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('Reopened prerequisite');
    expect(screen.queryByText('Waiting on 1 dependency')).not.toBeInTheDocument();
  });

  it('shows a restart failure instead of making the button appear inert', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...inReviewTask,
      failure: {
        reason: 'review_failed',
        detail: 'timed out after 10m',
        source: 'reviewer',
        attempt: 2,
        maxAttempts: 2,
        skipListed: true,
        at: '2024-01-01T01:00:00Z',
      },
    });
    mocked.restart.mockRejectedValue(new Error('restart rejected'));
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-11" tasks={[]} onClose={vi.fn()} onChanged={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Restart task' }));
    expect(await screen.findByText('restart rejected')).toBeInTheDocument();
  });

  it('lets a backlog task be moved to another workspace while editing', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(backlogTask);
    mocked.updateTask.mockClear();
    const user = userEvent.setup();

    render(
      <DetailPanel
        taskKey="AF-10"
        workspaces={['default', 'repo-a', 'repo-b']}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.getByLabelText('Workspace')).toHaveValue('repo-a');
    await user.selectOptions(screen.getByLabelText('Workspace'), 'repo-b');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.updateTask).toHaveBeenCalledWith('AF-10', expect.objectContaining({ workspace: 'repo-b' })));
  });

  it('lets an unclaimed queued task edit its brief but not move workspace', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({ ...backlogTask, status: 'queued' });
    mocked.updateTask.mockClear();
    const user = userEvent.setup();

    render(
      <DetailPanel
        taskKey="AF-10"
        workspaces={['default', 'repo-a', 'repo-b']}
        onClose={vi.fn()}
        onChanged={vi.fn()}
      />,
    );

    await user.click(await screen.findByRole('button', { name: 'Edit' }));
    expect(screen.queryByLabelText('Workspace')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.updateTask).toHaveBeenCalled());
    expect(mocked.updateTask.mock.calls[0]?.[1]).not.toHaveProperty('workspace');
  });

  it('deduplicates repeated links by kind and URL in the drawer', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...backlogTask,
      links: [
        { id: 1, taskId: 1, kind: 'branch', label: 'feature/AF-10-x', url: 'https://example.com/branch/x' },
        { id: 2, taskId: 1, kind: 'branch', label: 'feature/AF-10-x', url: 'https://example.com/branch/x' },
        { id: 3, taskId: 1, kind: 'pr', label: 'PR #42', url: 'https://example.com/pr/42' },
        { id: 4, taskId: 1, kind: 'pr', label: '#42', url: 'https://example.com/pr/42' },
      ],
    });

    const { container } = render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('This is the spec');
    const renderedLinks = [...container.querySelectorAll('.af-links .af-link')] as HTMLAnchorElement[];
    expect(renderedLinks.map((a) => a.href)).toEqual(['https://example.com/branch/x', 'https://example.com/pr/42']);
    expect(screen.getByRole('link', { name: 'PR #42' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: '#42' })).not.toBeInTheDocument();
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

  it('shows the review panel on an in_review code task; approving over a must-fix issue asks why', async () => {
    const mocked = await getApiMock();
    const brief = v1Brief([{ severity: 'error', file: 'src/x.ts', line: 42, title: 'Unbounded loop', detail: 'No cap.', criteria: ['AC1'] }]);
    mocked.getTask.mockResolvedValue({ ...inReviewTask, acceptanceCriteria: '1. Race — one claim wins\n2. Logs — one line', reviewBrief: brief });
    mocked.approve.mockClear();
    mocked.approve.mockResolvedValue({});
    const user = userEvent.setup();
    const onClose = vi.fn();

    render(<DetailPanel taskKey="AF-11" onClose={onClose} onChanged={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'Changes needed' })).toBeInTheDocument();
    // the table replaces the raw criteria block; the summary moves to the second column
    expect(screen.queryByText('Acceptance criteria', { selector: '.af-sl' })).toBeNull();
    expect(screen.getByText("Worker's summary")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve anyway…' }));
    // Esc closes the dialog, not the drawer
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Approve anyway…' }));
    await user.type(screen.getByLabelText(/Why is it OK to ship this\?/), 'Tracked in AF-12.');
    await user.click(screen.getByRole('button', { name: 'Approve anyway' }));
    expect(mocked.approve).toHaveBeenCalledWith('AF-11', 'Tracked in AF-12.');
  });

  it('approves a clean in_review task in one click', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, reviewBrief: v1Brief([]) });
    mocked.approve.mockClear();
    mocked.approve.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('heading', { name: 'No issues found' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Approve' }));
    expect(mocked.approve).toHaveBeenCalledWith('AF-11', undefined);
  });

  it('a pr-review task in review keeps its own actions', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, kind: 'pr-review', reviewBrief: v1Brief([]) });

    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Mark reviewed' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'No issues found' })).toBeNull();
    expect(screen.getByText('No issues found')).toBeInTheDocument(); // the chip
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

    expect(await screen.findByText('Metrics', { selector: '.af-sl' })).toBeInTheDocument();
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

    expect(await screen.findByText('Changes', { selector: '.af-sl' })).toBeInTheDocument();
    await waitFor(() => expect(mocked.getDiff).toHaveBeenCalledWith('AF-13'));
  });

  it('shows no Changes section without a branch link', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockClear();
    mocked.getTask.mockResolvedValue(backlogTask); // pr link only

    render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByText('This is the spec');
    expect(screen.queryByText('Changes', { selector: '.af-sl' })).not.toBeInTheDocument();
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

  it.each(['backlog', 'queued', 'in_progress', 'in_review', 'blocked', 'delivering', 'done'] as const)(
    'offers Cancel task on a %s task',
    async (status) => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue({ ...inProgressTask, status });

      render(<DetailPanel taskKey="AF-12" onClose={vi.fn()} onChanged={vi.fn()} />);

      expect(await screen.findByRole('button', { name: 'Cancel task' })).toBeInTheDocument();
    },
  );

  it('cancels a running task through the two-step confirm', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    mocked.getTask.mockResolvedValue(inProgressTask);
    mocked.setStatus.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-12" onClose={vi.fn()} onChanged={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Cancel task' }));
    // first click only arms — nothing cancelled yet
    expect(mocked.setStatus).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm cancel?' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-12', 'cancelled');
  });

  it('a cancelled task offers Reopen and Archive, not Cancel', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    mocked.archive.mockClear();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, key: 'AF-14', status: 'cancelled' });
    mocked.setStatus.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-14" onClose={vi.fn()} onChanged={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-14', 'queued');
    await user.click(screen.getByRole('button', { name: 'Archive' }));
    expect(mocked.archive).toHaveBeenCalledWith('AF-14');
    expect(screen.queryByRole('button', { name: 'Cancel task' })).not.toBeInTheDocument();
  });

  it('reopens a cancelled pr-review task to review', async () => {
    const mocked = await getApiMock();
    mocked.setStatus.mockClear();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, key: 'AF-15', status: 'cancelled', kind: 'pr-review' });
    mocked.setStatus.mockResolvedValue({});
    const user = userEvent.setup();

    render(<DetailPanel taskKey="AF-15" onClose={vi.fn()} onChanged={vi.fn()} />);

    await user.click(await screen.findByRole('button', { name: 'Reopen' }));
    expect(mocked.setStatus).toHaveBeenCalledWith('AF-15', 'in_review');
  });

  it('an archived cancelled task offers only Unarchive', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({ ...inReviewTask, key: 'AF-14', status: 'cancelled', archivedAt: '2026-06-01T00:00:00Z' });

    render(<DetailPanel taskKey="AF-14" onClose={vi.fn()} onChanged={vi.fn()} />);

    expect(await screen.findByRole('button', { name: 'Unarchive' })).toBeInTheDocument();
    for (const name of ['Reopen', 'Archive', 'Cancel task'])
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
  });

  it('hides the delete button on an in_progress task', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue(inProgressTask);

    render(<DetailPanel taskKey="AF-12" onClose={vi.fn()} onChanged={vi.fn()} />);

    await screen.findByRole('button', { name: 'Release claim' });
    expect(screen.queryByRole('button', { name: 'Delete task' })).not.toBeInTheDocument();
  });

  it.each(['queued', 'in_progress', 'blocked', 'in_review'] as const)('shows merged PR checks while %s without delivery override buttons', async (status) => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...inReviewTask, status,
      delivery: {
        provider: 'github', branch: 'feature/AF-144-fix', prUrl: 'https://github.com/o/r/pull/3', prId: '#3',
        prState: 'merged', checksState: 'failing', failing: [{ name: 'verify', url: 'https://ci/run/3' }],
        checkedAt: '2026-09-14T12:22:00Z', stateChangedAt: '2026-09-14T12:22:00Z',
      },
    });
    render(<DetailPanel taskKey={inReviewTask.key} onClose={vi.fn()} onChanged={vi.fn()} />);
    expect(await screen.findByText('PR #3 merged · checks failed')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'verify' })).toHaveAttribute('href', 'https://ci/run/3');
    expect(screen.queryByRole('button', { name: 'Mark done' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Re-queue' })).not.toBeInTheDocument();
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

  it('offers the create-PR deep link on a delivering task whose watcher poll found no PR', async () => {
    const mocked = await getApiMock();
    mocked.getTask.mockResolvedValue({
      ...inReviewTask,
      key: 'AF-22',
      status: 'delivering',
      delivery: {
        provider: 'azdo', branch: 'feature/AF-22-x', prUrl: null, prId: null,
        prState: 'not_found', checksState: 'unknown', failing: [],
        checkedAt: '2026-07-02T00:00:00Z', stateChangedAt: '2026-07-02T00:00:00Z',
      },
      createPrUrl: 'https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=feature%2FAF-22-x',
    });

    render(<DetailPanel taskKey="AF-22" onClose={vi.fn()} onChanged={vi.fn()} />);

    const link = await screen.findByRole('link', { name: 'Open PR in Azure DevOps' });
    expect(link).toHaveAttribute('href', 'https://dev.azure.com/o/p/_git/r/pullrequestcreate?sourceRef=feature%2FAF-22-x');
    expect(link).toHaveAttribute('target', '_blank');
    expect(screen.getByRole('button', { name: 'Mark done' })).toBeInTheDocument();
  });

  it('shows the agent\'s criterion claims as a summary line, not raw JSON', async () => {
    const mocked = await getApiMock();
    const body = 'criteria-claims/v1\n\n```json\n{"claims":[{"id":"AC1","claim":"race.test.ts proves it."},{"id":"AC2","claim":"One log line."}]}\n```';
    mocked.getTask.mockResolvedValue({ ...inReviewTask, activity: [{ ...backlogTask.activity[1]!, id: 30, actor: 'agent', body }] });
    const user = userEvent.setup();
    render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);

    const summary = await screen.findByText('Reported on 2 acceptance criteria');
    expect(screen.queryByText(/"claims"/)).toBeNull();
    await user.click(summary);
    expect(screen.getByText('race.test.ts proves it.')).toBeVisible();
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

  describe('tabbed layout', () => {
    it('always opens as the full dialog — no side drawer, no expand toggle', async () => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue(backlogTask);
      const { container } = render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);
      await screen.findByText('This is the spec');
      expect(screen.getByRole('tablist')).toBeInTheDocument();
      expect(container.querySelector('.af-drawer')).toBeNull();
      expect(screen.queryByRole('button', { name: /Expand|Collapse/ })).not.toBeInTheDocument();
    });

    it('opens on an Overview tab holding the spec, details and dependencies', async () => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue(backlogTask);
      render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);
      await screen.findByText('This is the spec');

      const tabs = screen.getAllByRole('tab').map((t) => t.textContent);
      expect(tabs).toEqual(['Overview', 'Changes', 'Logs', 'Metrics', 'Activity2']);
      expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('This is the spec')).toBeInTheDocument();
      expect(screen.getByText('These are the acceptance criteria')).toBeInTheDocument();
      expect(screen.getByText('c:/git/repo-a')).toBeInTheDocument();
      expect(screen.getByText('Dependencies')).toBeInTheDocument();
    });

    it('switches panels: Activity shows the timeline and hides the spec', async () => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue({ ...backlogTask, activity: [...Array.from({ length: 4 }, (_, i) => ({ ...backlogTask.activity[1]!, id: 10 + i, body: `older comment ${i}` })), { ...backlogTask.activity[1]!, id: 20 }] });
      const user = userEvent.setup();
      render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);
      await screen.findByText('This is the spec');

      // activity arrives oldest-first; Overview only previews the latest entries
      expect(screen.queryByText('older comment 0')).not.toBeInTheDocument();

      await user.click(screen.getByRole('tab', { name: /Activity/ }));
      expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByText('older comment 0')).toBeInTheDocument();
      expect(screen.queryByText('This is the spec')).not.toBeInTheDocument();
    });

    it('renders the diff inline on the Changes tab', async () => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue({ ...inReviewTask, links: [{ id: 9, taskId: 2, kind: 'branch', label: 'task/AF-11', url: 'https://example.com/b' }] });
      mocked.getDiff.mockResolvedValue({
        branch: 'task/AF-11', baseRef: 'main', commits: 1,
        diff: ['diff --git a/foo.ts b/foo.ts', '--- a/foo.ts', '+++ b/foo.ts', '@@ -1 +1 @@', '-old line', '+new line', ''].join('\n'),
      });
      const user = userEvent.setup();
      render(<DetailPanel taskKey="AF-11" onClose={vi.fn()} onChanged={vi.fn()} />);
      await screen.findByText('Implementation complete');
      await user.click(screen.getByRole('tab', { name: 'Changes' }));

      expect(await screen.findByText('new line')).toBeInTheDocument();
      expect(screen.queryByRole('dialog', { name: /Changes on/ })).not.toBeInTheDocument();
    });

    it('moves between tabs with the arrow keys', async () => {
      const mocked = await getApiMock();
      mocked.getTask.mockResolvedValue(backlogTask);
      const user = userEvent.setup();
      render(<DetailPanel taskKey="AF-10" onClose={vi.fn()} onChanged={vi.fn()} />);
      await screen.findByText('This is the spec');

      screen.getByRole('tab', { name: 'Overview' }).focus();
      await user.keyboard('{ArrowLeft}');
      expect(screen.getByRole('tab', { name: /Activity/ })).toHaveAttribute('aria-selected', 'true');
      expect(screen.getByRole('tab', { name: /Activity/ })).toHaveFocus();
    });
  });
});
