import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Changes } from '../../client/src/components/Changes.js';
import { MODIFY_MULTI_HUNK } from './fixtures/diffs.js';

vi.mock('../../client/src/api.js', () => ({
  api: { getDiff: vi.fn() },
}));

async function getApiMock() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { getDiff: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  (await getApiMock()).getDiff.mockReset();
});

const props = { taskKey: 'AF-7', branchLabel: 'task/AF-7', updatedAt: '2024-01-01T00:00:00Z' };

describe('Changes', () => {
  it('fetches the diff and shows a compact stat', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockResolvedValue({ branch: 'task/AF-7', baseRef: 'main', diff: MODIFY_MULTI_HUNK });

    render(<Changes {...props} />);

    expect(await screen.findByText('1 file')).toBeInTheDocument();
    expect(screen.getByText('+3')).toBeInTheDocument();
    expect(screen.getByText('−2')).toBeInTheDocument();
    expect(mocked.getDiff).toHaveBeenCalledWith('AF-7');
  });

  it('opens the diff modal without refetching', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockResolvedValue({ branch: 'task/AF-7', baseRef: 'main', diff: MODIFY_MULTI_HUNK });
    const user = userEvent.setup();

    render(<Changes {...props} />);

    await user.click(await screen.findByRole('button', { name: 'View diff' }));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName('Changes on task/AF-7');
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(mocked.getDiff).toHaveBeenCalledTimes(1);
  });

  it('shows "No changes" for an empty diff and offers no button', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockResolvedValue({ branch: 'task/AF-7', baseRef: 'main', diff: '' });

    render(<Changes {...props} />);

    expect(await screen.findByText('No changes vs main')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View diff' })).not.toBeInTheDocument();
  });

  it('surfaces fetch errors', async () => {
    const mocked = await getApiMock();
    mocked.getDiff.mockRejectedValue(new Error('not a git repository: /tmp/x'));

    render(<Changes {...props} />);

    expect(await screen.findByText('not a git repository: /tmp/x')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'View diff' })).not.toBeInTheDocument();
  });
});
