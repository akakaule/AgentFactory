import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ListView } from '../../client/src/views/ListView.js';
import type { Task } from '../../client/src/types.js';

function makeTask(key: string, title: string, status: Task['status'], workspace = 'default'): Task {
  return {
    id: Math.random(), key, title, status, stage: 'implementation', kind: 'code', spec: 'spec', acceptanceCriteria: 'ac',
    resultSummary: null, seq: 1, workspace, claimedBy: null, claimedAt: null, archivedAt: null, aiReview: null, failure: null,
    unmetDependencyCount: 0,
    delivery: null,
    createdAt: '2024-01-01T00:00:00Z', updatedAt: '2024-01-01T00:00:00Z',
  };
}

const tasks: Task[] = [
  makeTask('AF-6', 'Done task', 'done'),
  makeTask('AF-1', 'Backlog task', 'backlog'),
  makeTask('AF-3', 'In-progress task', 'in_progress'),
  makeTask('AF-4', 'In-review task', 'in_review'),
];

describe('ListView', () => {
  it('renders one row per task, sorted active-first / archive-last', () => {
    render(<ListView tasks={tasks} onOpen={vi.fn()} />);
    const titles = screen.getAllByRole('row').slice(1).map((r) => r.querySelector('.ti')?.textContent);
    expect(titles).toEqual(['In-progress task', 'In-review task', 'Backlog task', 'Done task']);
  });

  it('shows status with its label and owner', () => {
    const claimed = { ...makeTask('AF-9', 'Claimed task', 'in_progress'), claimedBy: 'worker-1', claimedAt: '2024-01-01T00:00:00Z' };
    render(<ListView tasks={[claimed, makeTask('AF-1', 'Plain task', 'backlog')]} onOpen={vi.fn()} />);
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    expect(screen.getByText('worker-1')).toBeInTheDocument();
    expect(screen.getByText('you')).toBeInTheDocument();
  });

  it('shows when a row is waiting on unmet dependencies', () => {
    render(
      <ListView
        tasks={[{ ...makeTask('AF-2', 'Waiting task', 'queued'), unmetDependencyCount: 1 }]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.getByText('Waiting on 1')).toBeInTheDocument();
  });

  it('does not show waiting on a row after the task has started', () => {
    render(
      <ListView
        tasks={[{ ...makeTask('AF-2', 'Active task', 'in_progress'), unmetDependencyCount: 1 }]}
        onOpen={vi.fn()}
      />,
    );

    expect(screen.queryByText('Waiting on 1')).not.toBeInTheDocument();
  });

  it('calls onOpen with the task key when a row is clicked', async () => {
    const onOpen = vi.fn();
    const user = userEvent.setup();
    render(<ListView tasks={tasks} onOpen={onOpen} />);
    await user.click(screen.getByText('In-review task'));
    expect(onOpen).toHaveBeenCalledWith('AF-4');
  });

  it('shows the workspace column only for multi-workspace boards', () => {
    const mixed = [makeTask('AF-1', 'A task', 'backlog', 'repo-a')];
    const { rerender } = render(<ListView tasks={mixed} onOpen={vi.fn()} />);
    expect(screen.queryByText('Workspace')).not.toBeInTheDocument();
    expect(screen.queryByText('repo-a')).not.toBeInTheDocument();

    rerender(<ListView tasks={mixed} multiWs onOpen={vi.fn()} />);
    expect(screen.getByText('Workspace')).toBeInTheDocument();
    expect(screen.getByText('repo-a')).toBeInTheDocument();
  });
});
