import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WorkspacesModal } from '../../client/src/components/WorkspacesModal.js';
import type { Workspace, WorkspaceDiagnosis } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    updateWorkspace: vi.fn().mockResolvedValue({}),
    createWorkspace: vi.fn().mockResolvedValue({}),
    getAgentModels: vi.fn().mockResolvedValue({ settings: { global: {}, workspaces: {} }, defaults: {}, catalog: [] }),
    setAgentModels: vi.fn(),
    diagnoseWorkspace: vi.fn(),
  },
}));
import { api } from '../../client/src/api.js';

const ws = (over: Partial<Workspace> = {}): Workspace => ({
  id: 1, name: 'repo-a', repoPath: '/a', createdAt: '2026-01-01T00:00:00.000Z',
  policy: null, verifyCommand: null, hasPat: false, promptOverrides: {},
  baseBranch: null, requiredChecks: null, ciMode: null,
  profile: {
    baseBranch: { value: 'main', source: 'detected' },
    requiredChecks: { value: [], source: 'default' },
    ciMode: { value: 'legacy', source: 'default' },
  },
  ...over,
});
const noop = () => {};

describe('WorkspacesModal — repository profile', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows each effective value and whether it is configured, detected or the default', () => {
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    const section = screen.getByTestId('repo-profile');
    expect(within(section).getByTestId('effective-baseBranch').textContent).toMatch(/main.*detected/);
    expect(within(section).getByTestId('effective-requiredChecks').textContent).toMatch(/none.*default/);
    expect(within(section).getByTestId('effective-ciMode').textContent).toMatch(/legacy.*default/);
  });

  it('labels configured values as configured and an undetectable branch as unresolved', () => {
    const { unmount } = render(<WorkspacesModal workspaces={[ws({
      baseBranch: 'develop', requiredChecks: ['build'], ciMode: 'required',
      profile: { baseBranch: { value: 'develop', source: 'configured' }, requiredChecks: { value: ['build'], source: 'configured' }, ciMode: { value: 'required', source: 'configured' } },
    })]} onCreated={noop} onClose={noop} />);
    expect(screen.getByTestId('effective-baseBranch').textContent).toMatch(/develop.*configured/);
    expect(screen.getByTestId('effective-requiredChecks').textContent).toMatch(/build.*configured/);
    expect(screen.getByTestId('effective-ciMode').textContent).toMatch(/required.*configured/);
    unmount();
    render(<WorkspacesModal workspaces={[ws({ profile: { ...ws().profile!, baseBranch: { value: null, source: 'unresolved' } } })]} onCreated={noop} onClose={noop} />);
    expect(screen.getByTestId('effective-baseBranch').textContent).toMatch(/unresolved/);
  });

  it('Saves the profile fields it edited, and only those', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    await user.type(screen.getByLabelText('Base branch'), 'develop');
    await user.type(screen.getByLabelText('Required checks'), 'build, test');
    await user.selectOptions(screen.getByLabelText('CI mode'), 'required');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({ baseBranch: 'develop', requiredChecks: ['build', 'test'], ciMode: 'required' }));
  });

  it('does not send untouched profile fields', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    await user.type(screen.getByPlaceholderText(/npm test/), 'npm test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const body = vi.mocked(api.updateWorkspace).mock.calls[0]![1];
    expect(body).not.toHaveProperty('baseBranch');
    expect(body).not.toHaveProperty('requiredChecks');
    expect(body).not.toHaveProperty('ciMode');
  });

  it('clearing a configured value sends null (back to detected / default)', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws({ baseBranch: 'develop', ciMode: 'none' })]} onCreated={noop} onClose={noop} />);
    await user.clear(screen.getByLabelText('Base branch'));
    await user.selectOptions(screen.getByLabelText('CI mode'), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateWorkspace).toHaveBeenCalledWith('repo-a', expect.objectContaining({ baseBranch: null, ciMode: null }));
  });

  it('after a save, the saved values become the baseline: clearing them again without reopening sends null', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    await user.type(screen.getByLabelText('Base branch'), ' develop ');
    await user.type(screen.getByLabelText('Required checks'), 'build,  test');
    await user.selectOptions(screen.getByLabelText('CI mode'), 'required');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateWorkspace).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText<HTMLInputElement>('Base branch').value).toBe('develop');
    await user.clear(screen.getByLabelText('Base branch'));
    await user.clear(screen.getByLabelText('Required checks'));
    await user.selectOptions(screen.getByLabelText('CI mode'), '');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.updateWorkspace).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.updateWorkspace).mock.calls[1]![1]).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
  });

  it('the PR creation switch sends false for Off, true for On and null for Follow watcher config', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    const select = screen.getByLabelText('Watcher opens PRs');
    await user.selectOptions(select, 'Off');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.selectOptions(select, 'On');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await user.selectOptions(select, 'Follow watcher config');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    const bodies = vi.mocked(api.updateWorkspace).mock.calls.map((c) => c[1]);
    expect(bodies).toEqual([
      expect.objectContaining({ createPullRequests: false }),
      expect.objectContaining({ createPullRequests: true }),
      expect.objectContaining({ createPullRequests: null }),
    ]);
  });

  it('Diagnose runs the read-only check and lists every result with its status and reason', async () => {
    const diagnosis: WorkspaceDiagnosis = {
      workspace: 'repo-a', repoPath: '/a',
      checks: [
        { id: 'repo_path', label: 'Repository path', status: 'ok', reason: 'exists with the exact on-disk case', detail: '/a' },
        { id: 'pat', label: 'Git PAT configured', status: 'not_applicable', reason: 'no workspace PAT stored' },
        { id: 'host_checks', label: 'Host check access', status: 'failed', reason: 'GitHub answered 401' },
      ],
    };
    vi.mocked(api.diagnoseWorkspace).mockResolvedValue(diagnosis);
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    await user.click(screen.getByRole('button', { name: 'Diagnose' }));
    expect(api.diagnoseWorkspace).toHaveBeenCalledWith('repo-a');
    const rows = await screen.findAllByTestId('diagnostic-row');
    expect(rows).toHaveLength(3);
    expect(rows[0]!.textContent).toMatch(/Repository path.*exists/);
    expect(rows[1]!.getAttribute('data-status')).toBe('not_applicable');
    expect(rows[2]!.getAttribute('data-status')).toBe('failed');
    expect(rows[2]!.textContent).toMatch(/401/);
  });

  it('shows a diagnose error instead of results', async () => {
    vi.mocked(api.diagnoseWorkspace).mockRejectedValue(new Error('boom'));
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws()]} onCreated={noop} onClose={noop} />);
    await user.click(screen.getByRole('button', { name: 'Diagnose' }));
    expect(await screen.findByText(/boom/)).toBeTruthy();
  });
});
