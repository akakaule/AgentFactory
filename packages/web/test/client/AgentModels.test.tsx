import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentModelsPanel } from '../../client/src/components/AgentModelsPanel.js';
import { WorkspacesModal } from '../../client/src/components/WorkspacesModal.js';
import type { AgentModelsView, Workspace } from '../../client/src/types.js';

const CATALOG = [
  { engine: 'claude' as const, id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { engine: 'claude' as const, id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { engine: 'codex' as const, id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
];

const view = (over: Partial<AgentModelsView> = {}): AgentModelsView => ({
  settings: {
    global: {
      stages: { description: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
      reviewers: [{ engine: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }],
    },
    workspaces: { 'kl-dis': { feedbackEval: { engine: 'codex' } } },
  },
  defaults: {
    dispatcher: { kind: 'dispatcher', at: '2026-10-23T08:00:00.000Z', roles: { stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5', extraArgs: ['--verbose'] } } } },
  },
  catalog: CATALOG,
  ...over,
});

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAgentModels: vi.fn(),
    setAgentModels: vi.fn(),
    updateWorkspace: vi.fn().mockResolvedValue({}),
    createWorkspace: vi.fn().mockResolvedValue({}),
  },
}));
import { api } from '../../client/src/api.js';
const mocked = api as unknown as Record<'getAgentModels' | 'setAgentModels' | 'updateWorkspace', ReturnType<typeof vi.fn>>;
const sentDoc = () => mocked.setAgentModels.mock.calls[0]![0];

const ENGINES_ON = { claude: { enabled: true }, codex: { enabled: true } };

describe('Agents › Models tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getAgentModels.mockResolvedValue(view());
    mocked.setAgentModels.mockImplementation(async (doc) => view({ settings: doc }));
  });

  it('renders board settings, file defaults with their supervisor, and the command preview', async () => {
    render(<AgentModelsPanel engines={ENGINES_ON} onClose={() => {}} />);
    const spec = await screen.findByRole('region', { name: 'Spec' });
    expect(within(spec).getByText('set on board')).toBeTruthy();
    expect(within(spec).getByText('claude -p --model claude-opus-5-5 --effort high')).toBeTruthy();
    expect(within(spec).getByRole('button', { name: 'Use config file' })).toBeTruthy();

    const impl = screen.getByRole('region', { name: 'Implementation' });
    expect(within(impl).getByText('from dispatcher.config.json · dispatcher')).toBeTruthy();
    expect(within(impl).getByText('claude -p --model claude-sonnet-5-5')).toBeTruthy();
    expect(within(impl).getByText('--verbose')).toBeTruthy(); // the stage args a board setting would drop
    expect(within(impl).queryByRole('button', { name: 'Use config file' })).toBeNull();

    const review = screen.getByRole('region', { name: 'Review' });
    expect(within(review).getByText('codex exec -m gpt-6.1-sol -c model_reasoning_effort="high"')).toBeTruthy();
    // no reviewer supervisor has reported: the source says so
    expect(screen.getByRole('region', { name: 'Change visualization' }).textContent).toContain('no supervisor has reported yet');
  });

  it('shows what happens when an engine is switched off', async () => {
    render(<AgentModelsPanel engines={{ claude: { enabled: true }, codex: { enabled: false } }} onClose={() => {}} />);
    const review = await screen.findByRole('region', { name: 'Review' });
    expect(within(review).getByRole('note').textContent).toContain('Codex is switched off: this reviewer is skipped and Claude · Opus 5.5 · high reviews alone');
    const user = userEvent.setup();
    const impl = screen.getByRole('region', { name: 'Implementation' });
    await user.click(within(impl).getByRole('button', { name: 'Codex' }));
    expect(within(impl).getByRole('note').textContent).toContain('runs on Claude at its default model');
  });

  it('Save sends the whole document, with the workspace overrides as loaded', async () => {
    const user = userEvent.setup();
    render(<AgentModelsPanel engines={ENGINES_ON} onClose={() => {}} />);
    const impl = await screen.findByRole('region', { name: 'Implementation' });
    await user.click(within(impl).getByRole('button', { name: 'medium' }));
    expect(screen.getByText('1 unsaved change')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.setAgentModels).toHaveBeenCalledTimes(1));
    expect(sentDoc()).toEqual({
      global: {
        stages: {
          description: { engine: 'claude', model: 'claude-opus-5-5', effort: 'high' },
          implementation: { engine: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' },
        },
        reviewers: view().settings.global.reviewers,
      },
      workspaces: { 'kl-dis': { feedbackEval: { engine: 'codex' } } },
    });
    expect(await screen.findByText('Saved')).toBeTruthy();
  });

  it('blocks Save on an unsafe custom model id', async () => {
    const user = userEvent.setup();
    render(<AgentModelsPanel engines={ENGINES_ON} onClose={() => {}} />);
    await screen.findByRole('region', { name: 'Spec' });
    await user.selectOptions(screen.getByLabelText('Spec model'), 'Custom model id…');
    const input = screen.getByLabelText('Spec custom model id');
    await user.clear(input);
    await user.type(input, 'bad id&x');
    expect(screen.getByRole('alert').textContent).toContain('letters, digits');
    expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('Reset to config files clears the global layer after an in-page confirm', async () => {
    const user = userEvent.setup();
    render(<AgentModelsPanel engines={ENGINES_ON} onClose={() => {}} />);
    await user.click(await screen.findByRole('button', { name: 'Reset to config files' }));
    expect(mocked.setAgentModels).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Reset' }));
    await waitFor(() => expect(mocked.setAgentModels).toHaveBeenCalledTimes(1));
    expect(sentDoc()).toEqual({ global: {}, workspaces: { 'kl-dis': { feedbackEval: { engine: 'codex' } } } });
  });

  it('adds and removes reviewers (at most 4)', async () => {
    const user = userEvent.setup();
    render(<AgentModelsPanel engines={ENGINES_ON} onClose={() => {}} />);
    const review = await screen.findByRole('region', { name: 'Review' });
    const add = within(review).getByRole('button', { name: '+ Add reviewer' });
    await user.click(add);
    await user.click(within(review).getAllByRole('button', { name: 'Remove' })[0]!);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.setAgentModels).toHaveBeenCalled());
    expect(sentDoc().global.reviewers).toEqual([{ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }, { engine: 'codex' }]);
  });
});

describe('Workspaces › Agent models', () => {
  const ws = (name: string): Workspace => ({ id: name === 'kl-dis' ? 1 : 2, name, repoPath: `/${name}`, createdAt: '2026-01-01T00:00:00.000Z', policy: null, verifyCommand: null, hasPat: false, promptOverrides: {} });

  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getAgentModels.mockResolvedValue(view());
    mocked.setAgentModels.mockImplementation(async (doc) => view({ settings: doc }));
  });

  it('ticking an override copies the global setting; Save replaces only this workspace\'s entry', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws('kl-dis'), ws('other')]} focusWorkspace="kl-dis" onCreated={() => {}} onClose={() => {}} />);
    expect(await screen.findByText('Agent models — 1 of 5 steps overridden')).toBeTruthy();
    expect(screen.getByText('Uses global: Claude · Opus 5.5 · high')).toBeTruthy();

    await user.click(screen.getByLabelText('Override Review for this workspace'));
    // the whole global reviewer list is copied in, editable as a list
    expect(screen.getByText('codex exec -m gpt-6.1-sol -c model_reasoning_effort="high"')).toBeTruthy();
    await user.click(screen.getAllByRole('button', { name: 'Remove' })[0]!);
    await user.click(screen.getByLabelText('Override Implementation for this workspace'));
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.setAgentModels).toHaveBeenCalledTimes(1));
    expect(sentDoc()).toEqual({
      global: view().settings.global,
      workspaces: {
        'kl-dis': {
          feedbackEval: { engine: 'codex' },
          reviewers: [{ engine: 'claude', model: 'claude-opus-5-5', effort: 'high' }],
          stages: { implementation: { engine: 'claude', model: 'claude-sonnet-5-5' } }, // copied from the file default
        },
      },
    });
    await waitFor(() => expect(mocked.updateWorkspace).toHaveBeenCalled());
  });

  it('leaves the model settings alone when the section was not touched', async () => {
    const user = userEvent.setup();
    render(<WorkspacesModal workspaces={[ws('kl-dis')]} focusWorkspace="kl-dis" onCreated={() => {}} onClose={() => {}} />);
    await screen.findByText('Agent models — 1 of 5 steps overridden');
    await user.type(screen.getByPlaceholderText(/All new code is TDD/), 'x');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocked.updateWorkspace).toHaveBeenCalled());
    expect(mocked.setAgentModels).not.toHaveBeenCalled();
  });
});
