import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../client/src/App.js';

// Mock must be at module level, hoisted by vitest
vi.mock('../../client/src/api.js', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({
      id: 1, key: 'AF-1', title: 'Test task', status: 'backlog',
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
  },
}));

import { api } from '../../client/src/api.js';

const ws = (id: number, name: string, repoPath: string) =>
  ({ id, name, repoPath, createdAt: '2024-01-01T00:00:00Z' });

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
  it('renders the header and list/board toggle by default', () => {
    render(<App />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AgentFactory');
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Board' })).toBeInTheDocument();
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

    await user.click(screen.getByRole('button', { name: 'Board' }));

    // BoardView renders StatusBadge columns for all 6 statuses
    expect(screen.getAllByText('Backlog').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
  });

  it('switches back to list view from board view', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Board' }));
    await user.click(screen.getByRole('button', { name: 'List' }));

    // Back in list view — no board columns (h3 headers for groups only appear in list)
    expect(screen.queryByText('In Progress')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'List' })).toBeInTheDocument();
  });

  it('hides the workspace filter while only one workspace exists', async () => {
    render(<App />);
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByLabelText('Workspace filter')).not.toBeInTheDocument();
  });

  it('shows the workspace filter when two or more workspaces exist', async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([ws(1, 'default', '.'), ws(2, 'repo-a', '/a')]);
    render(<App />);
    expect(await screen.findByLabelText('Workspace filter')).toBeInTheDocument();
  });

  it('refetches tasks scoped to the selected workspace', async () => {
    vi.mocked(api.listWorkspaces).mockResolvedValue([ws(1, 'default', '.'), ws(2, 'repo-a', '/a')]);
    const user = userEvent.setup();
    render(<App />);

    const select = await screen.findByLabelText('Workspace filter');
    await user.selectOptions(select, 'repo-a');

    expect(api.listTasks).toHaveBeenCalledWith({ workspace: 'repo-a' });
  });

  it('creates a workspace from the Workspaces modal', async () => {
    const user = userEvent.setup();
    render(<App />);

    await user.click(screen.getByRole('button', { name: 'Workspaces' }));
    await user.type(screen.getByPlaceholderText('workspace-slug'), 'repo-b');
    await user.type(screen.getByPlaceholderText('Absolute repo path'), 'C:/Git/RepoB');
    await user.click(screen.getByRole('button', { name: 'Create workspace' }));

    expect(api.createWorkspace).toHaveBeenCalledWith({ name: 'repo-b', repoPath: 'C:/Git/RepoB' });
  });
});
