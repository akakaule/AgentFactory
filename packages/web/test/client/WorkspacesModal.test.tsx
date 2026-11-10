import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacesModal } from '../../client/src/components/WorkspacesModal.js';
import type { CredentialHealthView, Workspace } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    updateWorkspace: vi.fn().mockResolvedValue({}),
    createWorkspace: vi.fn().mockResolvedValue({}),
    getAgentModels: vi.fn().mockResolvedValue({ settings: { global: {}, workspaces: {} }, defaults: {}, catalog: [] }),
    setAgentModels: vi.fn(),
    checkCredential: vi.fn().mockResolvedValue({ credential: null }),
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

describe('WorkspacesModal — single-workspace edit mode', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows only the focused workspace (no create row) when opened via "Edit <name>"', () => {
    const list = [ws(), ws({ id: 2, name: 'repo-b', repoPath: '/b' })];
    render(<WorkspacesModal workspaces={list} focusWorkspace="repo-b" onCreated={noop} onClose={noop} />);

    expect(screen.getByRole('heading', { name: 'Edit repo-b' })).toBeTruthy();
    expect(screen.getByText('repo-b')).toBeTruthy();
    expect(screen.queryByText('repo-a')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create workspace' })).toBeNull();
  });

  it('lists every workspace plus the create row when no workspace is focused', () => {
    const list = [ws(), ws({ id: 2, name: 'repo-b', repoPath: '/b' })];
    render(<WorkspacesModal workspaces={list} focusWorkspace={null} onCreated={noop} onClose={noop} />);

    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByText('repo-a')).toBeTruthy();
    expect(screen.getByText('repo-b')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Create workspace' })).toBeTruthy();
  });

  it('falls back to the full list when the focused workspace no longer exists', () => {
    render(<WorkspacesModal workspaces={[ws()]} focusWorkspace="gone" onCreated={noop} onClose={noop} />);

    expect(screen.getByRole('heading', { name: 'Workspaces' })).toBeTruthy();
    expect(screen.getByText('repo-a')).toBeTruthy();
  });
});

describe('WorkspacesModal — Azure DevOps work-item import', () => {
  beforeEach(() => vi.clearAllMocks());
  const ado = { provider: 'azdo' as const, organization: 'kl', project: 'DIS' };

  it('offers the import only for an Azure DevOps origin', () => {
    render(<WorkspacesModal workspaces={[ws({ remote: { provider: 'github' } })]} onCreated={noop} onClose={noop} />);
    expect(screen.queryByLabelText('Import work items from Azure DevOps')).toBeNull();
    expect(screen.getByText(/Work-item import needs an Azure DevOps origin/)).toBeTruthy();
  });

  it('saves the settings (lists split on commas) when the section is edited', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ remote: ado })]} onCreated={noop} onClose={noop} />);
    expect(screen.getByText(/kl \/ DIS/)).toBeTruthy();

    await user.click(screen.getByLabelText('Import work items from Azure DevOps'));
    const types = screen.getByLabelText('Work item types');
    await user.clear(types);
    await user.type(types, 'User Story, Bug');
    await user.type(screen.getByLabelText('Area path'), 'DIS/Integration');
    await user.type(screen.getByLabelText('Required tag'), 'ai-agent');
    await user.selectOptions(screen.getByLabelText('Start stage'), 'implementation');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({
      adoSync: expect.objectContaining({
        enabled: true, workItemTypes: ['User Story', 'Bug'], states: ['New'], areaPath: 'DIS/Integration',
        requiredTag: 'ai-agent', stage: 'implementation', closeState: 'Closed', maxImportsPerTick: 10,
      }),
    }));
  });

  it('leaves adoSync out of the save when the section was not touched, and shows the saved query', async () => {
    const user = userEvent.setup();
    const saved = {
      enabled: true, workItemTypes: ['User Story'], states: ['New'], areaPath: '', iterationPath: '', requiredTag: '', orderBy: '',
      assignTo: '', claimState: 'Active', reviewState: 'Resolved', closeState: 'Closed', markerTag: 'agentfactory',
      stage: 'description' as const, autoQueue: true, maxDescriptionChars: 8000, maxImportsPerTick: 10,
    };
    render(<WorkspacesModal workspaces={[ws({ remote: ado, adoSync: saved, adoSyncWiql: 'SELECT [System.Id] FROM WorkItems WHERE x' })]} onCreated={noop} onClose={noop} />);
    expect(screen.getByText('SELECT [System.Id] FROM WorkItems WHERE x')).toBeTruthy();
    expect((screen.getByLabelText('Import work items from Azure DevOps') as HTMLInputElement).checked).toBe(true);

    await user.type(screen.getByPlaceholderText('Paste a personal access token'), 'tok');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect((api.updateWorkspace as ReturnType<typeof vi.fn>).mock.calls[0]![1]).not.toHaveProperty('adoSync');
  });
});

describe('WorkspacesModal — credential health', () => {
  beforeEach(() => vi.clearAllMocks());
  const health = (over: Partial<CredentialHealthView>): CredentialHealthView => ({
    workspace: 'repo-a', state: 'ok', status: 'ok', checkedAt: new Date(Date.now() - 180_000).toISOString(), failingSince: null,
    error: null, expiresAt: null, expiresInDays: null, ...over,
  });

  it.each([
    [health({}), /works · checked 3m ago/],
    [health({ state: 'expiring', expiresAt: '2026-11-04T12:00:00.000Z', expiresInDays: 5 }), /works · expires in 5d/],
    [health({ state: 'failing', status: 'failing', failingSince: '2026-10-30T13:50:00.000Z', error: 'fatal: Authentication failed' }), /rejected since/],
    [health({ state: 'unreachable', status: 'unreachable', error: 'timed out' }), /couldn't check/],
  ])('badges the PAT with its last check (%#)', (credential, text) => {
    render(<WorkspacesModal workspaces={[ws({ hasPat: true })]} credentials={[credential]} onCreated={noop} onClose={noop} />);
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it('checks the credential on demand and right after a new PAT is saved', async () => {
    const onCheck = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ hasPat: true })]} credentials={[]} onCredentialCheck={onCheck} onCreated={noop} onClose={noop} />);

    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(onCheck).toHaveBeenLastCalledWith('repo-a');

    await user.type(screen.getByPlaceholderText('Enter a new PAT to replace the stored one'), 'fresh-pat');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onCheck).toHaveBeenCalledTimes(2));
  });
});
