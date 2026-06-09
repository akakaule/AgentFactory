import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../client/src/App.js';
import type { Task } from '../../client/src/types.js';

// Mock must be at module level, hoisted by vitest
vi.mock('../../client/src/api.js', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({
      id: 1, key: 'AF-1', title: 'Test task', status: 'backlog',
      spec: 'spec', acceptanceCriteria: 'ac', resultSummary: null,
      seq: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
      activity: [], links: [],
    }),
    createTask: vi.fn().mockResolvedValue({}),
    updateTask: vi.fn().mockResolvedValue({}),
    setStatus: vi.fn().mockResolvedValue({}),
    approve: vi.fn().mockResolvedValue({}),
    requestChanges: vi.fn().mockResolvedValue({}),
    addComment: vi.fn().mockResolvedValue({}),
  },
}));

const tasks: Task[] = [
  {
    id: 1, key: 'AF-1', title: 'A backlog task', status: 'backlog',
    spec: 'spec', acceptanceCriteria: 'ac', resultSummary: null,
    seq: 1, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
  {
    id: 2, key: 'AF-2', title: 'A queued task', status: 'queued',
    spec: 'spec', acceptanceCriteria: 'ac', resultSummary: null,
    seq: 2, createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  },
];

beforeEach(() => {
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
});
