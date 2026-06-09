import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { GroupedList } from '../../client/src/views/GroupedList.js';
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
    createdAt: '2024-01-01T00:00:00Z',
    updatedAt: '2024-01-01T00:00:00Z',
  };
}

const tasks: Task[] = [
  makeTask('AF-1', 'Backlog task', 'backlog'),
  makeTask('AF-2', 'Queued task', 'queued'),
  makeTask('AF-3', 'In-progress task', 'in_progress'),
  makeTask('AF-4', 'In-review task', 'in_review'),
  makeTask('AF-5', 'Blocked task', 'blocked'),
  makeTask('AF-6', 'Done task', 'done'),
];

describe('GroupedList', () => {
  it('renders status group headers in lifecycle order', () => {
    render(<GroupedList tasks={tasks} onSelect={vi.fn()} />);

    const headers = screen.getAllByRole('heading', { level: 3 });
    const labels = headers.map((h) => h.textContent);
    expect(labels).toEqual(['Backlog', 'Queued', 'In Progress', 'In Review', 'Blocked', 'Done']);
  });

  it('places each task title under the correct group', () => {
    render(<GroupedList tasks={tasks} onSelect={vi.fn()} />);

    expect(screen.getByText('Backlog task')).toBeInTheDocument();
    expect(screen.getByText('Queued task')).toBeInTheDocument();
    expect(screen.getByText('In-progress task')).toBeInTheDocument();
    expect(screen.getByText('In-review task')).toBeInTheDocument();
    expect(screen.getByText('Blocked task')).toBeInTheDocument();
    expect(screen.getByText('Done task')).toBeInTheDocument();
  });

  it('omits headers for empty statuses', () => {
    const partial = [makeTask('AF-1', 'Only backlog', 'backlog')];
    render(<GroupedList tasks={partial} onSelect={vi.fn()} />);

    const headers = screen.getAllByRole('heading', { level: 3 });
    expect(headers).toHaveLength(1);
    expect(headers[0]).toHaveTextContent('Backlog');
  });

  it('calls onSelect with the task key when a row is clicked', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<GroupedList tasks={tasks} onSelect={onSelect} />);

    await user.click(screen.getByText('Queued task'));
    expect(onSelect).toHaveBeenCalledWith('AF-2');
  });
});
