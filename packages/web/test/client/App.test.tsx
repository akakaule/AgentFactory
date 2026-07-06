import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../client/src/App.js';

// Mock must be at module level, hoisted by vitest
vi.mock('../../client/src/api.js', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({
      id: 1, key: 'AF-1', title: 'Test task', status: 'backlog', stage: 'implementation',
      spec: 'spec', acceptanceCriteria: 'ac', resultSummary: null,
      seq: 1, workspace: 'default', repoPath: '.',
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      activity: [], links: [],
    }),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    setStatus: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    addComment: vi.fn().mockResolvedValue({}),
    listWorkspaces: vi.fn(),
    createWorkspace: vi.fn().mockResolvedValue({}),
    getAnalytics: vi.fn().mockResolvedValue({ tasks: [], stranded: [] }),
  },
  eventsUrl: () => '/events',
  setUnauthorizedHandler: () => {},
}));

import { api } from '../../client/src/api.js';

const ws = (id: number, name: string, repoPath: string) =>
  ({ id, name, repoPath, policy: null, verifyCommand: null, createdAt: '2024-01-01T00:00:00Z' });

beforeEach(() => {
  vi.mocked(api.listWorkspaces).mockResolvedValue([ws(1, 'default', '.')]);
  // Set up no-op EventSource for App (uses useTasks → useEventStream)
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
    get onerror() { return null; },
    set onerror(_fn: unknown) {},
  })) as unknown as typeof EventSource;
});

describe('App', () => {
  it('renders the header and the three-view toggle by default', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AgentFactory');
    // scope to the header — the mobile bottom tab bar mirrors these same view buttons
    const header = within(screen.getByRole('banner'));
    expect(header.getByRole('button', { name: 'Board' })).toBeInTheDocument();
    expect(header.getByRole('button', { name: 'List' })).toBeInTheDocument();
    expect(header.getByRole('button', { name: 'Analytics' })).toBeInTheDocument();
  });

  it('switches to analytics and hides task chrome', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Analytics' }));

    expect(await screen.findByText('No completed tasks in this range')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New task' })).not.toBeInTheDocument();
    expect(screen.queryByPlaceholderText('Search tasks…')).not.toBeInTheDocument();
  });

  it('shows the create task form when "New task" is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'New task' }));

    expect(screen.getByText('New Task')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Task title')).toBeInTheDocument();
  });

  it('hides the create form when Cancel is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'New task' }));
    expect(screen.getByText('New Task')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('New Task')).not.toBeInTheDocument();
  });

  it('switches to board view when Board button is clicked', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(within(screen.getByRole('banner')).getByRole('button', { name: 'Board' }));

    // BoardView renders StatusBadge columns for all 6 statuses
    expect(screen.getAllByText('Backlog').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
  });

  it('switches back to list view from board view', async () => {
    const user = userEvent.setup();
    render(<App />);

    const header = within(screen.getByRole('banner'));
    await user.click(header.getByRole('button', { name: 'Board' }));
    await user.click(header.getByRole('button', { name: 'List' }));

    // Back in list view — no board columns (h3 headers for groups only appear in list)
    expect(screen.queryByText('In Progress')).not.toBeInTheDocument();
    expect(header.getByRole('button', { name: 'List' })).toBeInTheDocument();
  });

  it('always shows the workspace switcher, defaulting to All workspaces', async () => {
    render(<App />);
    const switcher = await screen.findByLabelText('Workspace filter');
    expect(switcher).toHaveTextContent('All workspaces');
  });

  it('filters the board to the selected workspace', async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([ws(1, 'default', '.'), ws(2, 'repo-a', '/a')]);
    const mkTask = (key: string, title: string, workspace: string) => ({
      id: Math.random(), key, title, status: 'backlog' as const, stage: 'implementation' as const, spec: 's', acceptanceCriteria: 'a',
      resultSummary: null, seq: 1, workspace, claimedBy: null, claimedAt: null, archivedAt: null, aiReview: null, failure: null,
      createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
    });
    vi.mocked(api.listTasks).mockResolvedValue([mkTask('AF-1', 'Default task', 'default'), mkTask('AF-2', 'Repo-a task', 'repo-a')]);
    const user = userEvent.setup();
    render(<App />);

    expect(await screen.findByText('Default task')).toBeInTheDocument();
    expect(screen.getByText('Repo-a task')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Workspace filter'));
    // the repo-a row is the 3rd menu child (All / default / repo-a / New…); click its filter button
    await user.click(screen.getByRole('menu').querySelector('.af-ws-optrow:nth-child(3) .af-ws-opt')!);

    expect(screen.queryByText('Default task')).not.toBeInTheDocument();
    expect(screen.getByText('Repo-a task')).toBeInTheDocument();
  });

  it('creates a workspace from the switcher’s "New workspace" entry', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Workspace filter'));
    await user.click(screen.getByRole('button', { name: /New workspace/ }));
    await user.type(screen.getByPlaceholderText('workspace-slug'), 'repo-b');
    await user.type(screen.getByPlaceholderText('Absolute repo path'), 'C:/Git/RepoB');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(api.createWorkspace).toHaveBeenCalledWith({ name: 'repo-b', repoPath: 'C:/Git/RepoB' });
  });

  it('opens the workspace editor from a row’s Edit button, ready to edit that workspace', async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([ws(1, 'default', '.'), ws(2, 'repo-a', '/a')]);
    const user = userEvent.setup();
    render(<App />);

    await user.click(await screen.findByLabelText('Workspace filter')); // open the switcher dropdown
    await user.click(screen.getByRole('button', { name: 'Edit repo-a' })); // per-workspace edit affordance

    // the editor is open with repo-a's repo path as an editable field (value '/a')
    expect(screen.getByDisplayValue('/a')).toBeInTheDocument();
  });
});
