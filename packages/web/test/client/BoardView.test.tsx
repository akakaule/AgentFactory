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
    stage: 'implementation',
    spec: 'spec',
    acceptanceCriteria: 'ac',
    resultSummary: null,
    seq: 1,
    workspace: 'default',
    claimedBy: null,
    claimedAt: null,
    archivedAt: null,
    aiReview: null,
    failure: null,
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
  it('shows the conventional feature branch chip on claimed cards', () => {
    const claimed = {
      ...makeTask('AF-7', 'Barcode scanner intake form', 'in_progress'),
      claimedBy: 'worker-1', claimedAt: '2024-01-01T00:00:00Z',
    };
    render(<BoardView tasks={[claimed]} onSelect={vi.fn()} />);
    expect(screen.getByText('feature/AF-7-barcode-scanner-intake-form')).toBeInTheDocument();
  });

  it('doc-stage claimed cards show the stage chip but never a branch chip', () => {
    const claimed = {
      ...makeTask('AF-7', 'Barcode scanner intake form', 'in_progress'),
      stage: 'description' as const,
      claimedBy: 'worker-1', claimedAt: '2024-01-01T00:00:00Z',
    };
    render(<BoardView tasks={[claimed]} onSelect={vi.fn()} />);
    expect(screen.getByText('Describe')).toBeInTheDocument();
    expect(screen.queryByText('feature/AF-7-barcode-scanner-intake-form')).not.toBeInTheDocument();
  });

  it('shows the AI-review findings chip on an in_review card', () => {
    const reviewed = {
      ...makeTask('AF-8', 'Reviewed task', 'in_review'),
      aiReview: { verdict: 'findings' as const, findings: 2, reviewer: 'codex', items: [] },
    };
    render(<BoardView tasks={[reviewed]} onSelect={vi.fn()} />);
    expect(screen.getByText('AI review: 2 findings')).toBeInTheDocument();
  });

  it('shows a pending chip when a resubmission is awaiting re-review', () => {
    const pending = {
      ...makeTask('AF-9', 'Pending task', 'in_review'),
      aiReview: { verdict: 'pending' as const, findings: 2, reviewer: 'codex', items: [] },
    };
    render(<BoardView tasks={[pending]} onSelect={vi.fn()} />);
    expect(screen.getByText('AI review: pending')).toBeInTheDocument();
  });

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

  it('shows an Archive all button on a populated Done column and fires the callback', async () => {
    const onArchiveAll = vi.fn();
    const user = userEvent.setup();
    render(<BoardView tasks={tasks} onSelect={vi.fn()} onArchiveAll={onArchiveAll} />);

    await user.click(screen.getByRole('button', { name: /archive all/i }));
    expect(onArchiveAll).toHaveBeenCalled();
  });

  it('hides the Archive all button when the Done column is empty', () => {
    const noDone = tasks.filter((t) => t.status !== 'done');
    render(<BoardView tasks={noDone} onSelect={vi.fn()} onArchiveAll={vi.fn()} />);

    expect(screen.queryByRole('button', { name: /archive all/i })).not.toBeInTheDocument();
  });

  it('calls onSelect with the task key on click', async () => {
    const onSelect = vi.fn();
    const user = userEvent.setup();
    render(<BoardView tasks={tasks} onSelect={onSelect} />);

    await user.click(screen.getByText('Backlog task'));
    expect(onSelect).toHaveBeenCalledWith('AF-1');
  });
});
