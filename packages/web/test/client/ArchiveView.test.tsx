import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ArchiveView } from '../../client/src/views/ArchiveView.js';
import type { Task } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    listTasks: vi.fn().mockResolvedValue([]),
  },
  eventsUrl: () => '/events',
}));

beforeEach(() => {
  globalThis.EventSource = vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    close: vi.fn(),
    get onerror() { return null; },
    set onerror(_fn: unknown) {},
  })) as unknown as typeof EventSource;
});

function makeArchived(key: string, title: string, opts: Partial<Task> = {}): Task {
  return {
    id: Math.random(),
    key,
    title,
    status: 'done',
    stage: 'implementation',
    spec: 'spec text',
    acceptanceCriteria: 'ac',
    resultSummary: null,
    seq: 1,
    workspace: 'default',
    claimedBy: null,
    claimedAt: null,
    archivedAt: '2026-06-01T00:00:00Z',
    aiReview: null,
    failure: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-06-01T00:00:00Z',
    ...opts,
  };
}

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { listTasks: ReturnType<typeof vi.fn> };
}

describe('ArchiveView', () => {
  it('fetches archived tasks and lists them', async () => {
    const mocked = await getApiMock();
    mocked.listTasks.mockResolvedValue([
      makeArchived('AF-1', 'Old feature'),
      makeArchived('AF-2', 'Old bugfix'),
    ]);

    render(<ArchiveView wsFilter="all" query="" multiWs={false} onOpen={vi.fn()} />);

    expect(await screen.findByText('Old feature')).toBeInTheDocument();
    expect(screen.getByText('Old bugfix')).toBeInTheDocument();
    expect(mocked.listTasks).toHaveBeenCalledWith({ archived: true });
  });

  it('filters by the selected workspace', async () => {
    const mocked = await getApiMock();
    mocked.listTasks.mockResolvedValue([
      makeArchived('AF-1', 'In default', { workspace: 'default' }),
      makeArchived('AF-2', 'In other', { workspace: 'other' }),
    ]);

    render(<ArchiveView wsFilter="other" query="" multiWs={true} onOpen={vi.fn()} />);

    expect(await screen.findByText('In other')).toBeInTheDocument();
    expect(screen.queryByText('In default')).not.toBeInTheDocument();
  });

  it('searches by key, title, and spec text', async () => {
    const mocked = await getApiMock();
    mocked.listTasks.mockResolvedValue([
      makeArchived('AF-1', 'Alpha', { spec: 'about the scanner' }),
      makeArchived('AF-2', 'Beta', { spec: 'something else' }),
    ]);

    const { rerender } = render(<ArchiveView wsFilter="all" query="scanner" multiWs={false} onOpen={vi.fn()} />);
    expect(await screen.findByText('Alpha')).toBeInTheDocument();
    expect(screen.queryByText('Beta')).not.toBeInTheDocument();

    rerender(<ArchiveView wsFilter="all" query="af-2" multiWs={false} onOpen={vi.fn()} />);
    await waitFor(() => {
      expect(screen.getByText('Beta')).toBeInTheDocument();
      expect(screen.queryByText('Alpha')).not.toBeInTheDocument();
    });
  });

  it('opens a task on row click', async () => {
    const mocked = await getApiMock();
    mocked.listTasks.mockResolvedValue([makeArchived('AF-1', 'Old feature')]);
    const onOpen = vi.fn();
    const user = userEvent.setup();

    render(<ArchiveView wsFilter="all" query="" multiWs={false} onOpen={onOpen} />);

    await user.click(await screen.findByText('Old feature'));
    expect(onOpen).toHaveBeenCalledWith('AF-1');
  });

  it('shows an empty state when nothing is archived', async () => {
    const mocked = await getApiMock();
    mocked.listTasks.mockResolvedValue([]);

    render(<ArchiveView wsFilter="all" query="" multiWs={false} onOpen={vi.fn()} />);

    expect(await screen.findByText(/no archived tasks/i)).toBeInTheDocument();
  });
});
