import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacesModal } from '../../client/src/components/WorkspacesModal.js';
import type { Workspace } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    updateWorkspace: vi.fn().mockResolvedValue({}),
    createWorkspace: vi.fn().mockResolvedValue({}),
  },
}));
import { api } from '../../client/src/api.js';

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 1, name: 'repo-a', repoPath: '/a', createdAt: '2026-01-01T00:00:00.000Z',
  policy: null, verifyCommand: null, hasPat: false, promptOverrides: {}, ...over,
});
const noop = () => {};

describe('WorkspacesModal — git PAT is settable in the web UI', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders a masked PAT field showing "not set" and Saves { pat } when a token is entered', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);

    expect(screen.getByText('not set')).toBeTruthy();
    const input = screen.getByPlaceholderText('Paste a personal access token') as HTMLInputElement;
    expect(input.type).toBe('password'); // masked

    await user.type(input, 'my-secret-pat');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({ pat: 'my-secret-pat' }));
  });

  it('shows "set ✓" + a Clear button when a PAT exists, and Clear sends { pat: null }', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ hasPat: true })]} onCreated={noop} onClose={noop} />);

    expect(screen.getByText('set ✓')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Clear' }));

    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', { pat: null });
  });

  it('lets you edit an existing workspace repoPath and Saves it', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ repoPath: '/old' })]} onCreated={noop} onClose={noop} />);

    const input = screen.getByDisplayValue('/old');
    await user.clear(input);
    await user.type(input, '/new/path');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({ repoPath: '/new/path' }));
  });

  it('sends promptOverrides when a per-workspace agent-prompt override is entered', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);

    await user.type(screen.getByLabelText('override Reviewer'), 'workspace-specific review focus');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({ promptOverrides: { reviewer: 'workspace-specific review focus' } }));
  });

  it('does not touch the PAT when only policy changed (no accidental clear)', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ hasPat: true })]} onCreated={noop} onClose={noop} />);

    await user.type(screen.getByPlaceholderText(/All new code is TDD/), ' extra');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    const body = (api.updateWorkspace as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![1] as Record<string, unknown>;
    expect(body).not.toHaveProperty('pat'); // PAT left blank → omitted → stays untouched
  });
});
