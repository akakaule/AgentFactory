import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BoardView } from '../../client/src/views/BoardView.js';
import type { Task } from '../../client/src/types.js';

function makeTask(key: string, title: string, status: Task['status']): Task {
  return {
    id: Math.random(),
    key,
    title,
    status,
    spec: 'spec',
    acceptanceCriteria: 'ac',
    resultSummary: null,
    seq: 1,
    workspace: 'default',
    claimedBy: null,
    claimedAt: null,
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

const tasks: Task[] = [
  makeTask('AF-1', 'Backlog task', 'backlog'),
  makeTask('AF-2', 'Queued task', 'queued'),
  makeTask('AF-3', 'Done task', 'done'),
];

describe('BoardView', () => {
  it('renders a column for every status in lifecycle order', () => {
    render(<BoardView tasks={tasks} onSelect={vi.fn()} />);

    // All 6 status badges appear (column headers)
    expect(screen.getAllByText('Backlog').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Queued').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Progress').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('In Review').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Blocked').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('Done').length).toBeGreaterThanOrEqual(1);
  });

  it('places each task in its status column', () => {
    render(<BoardView tasks={tasks} onSelect={vi.fn()} />);

    expect(screen.getByText('Backlog task')).toBeInTheDocument();
    expect(screen.getByText('Queued task')).toBeInTheDocument();
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('calls onSelect with the task key on click', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<BoardView tasks={tasks} onSelect={onSelect} />);

    await user.click(screen.getByText('Backlog task'));
    expect(onSelect).toHaveBeenCalledWith('AF-1');
  });
});
