import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { IntakeSettingsPanel } from '../../client/src/components/IntakeSettingsPanel.js';
import type { IntakeSettings, Workspace } from '../../client/src/types.js';

vi.mock('../../client/src/api.js', () => ({
  api: { getIntakeSettings: vi.fn(), setIntakeSettings: vi.fn() },
}));

const saved: IntakeSettings = {
  mode: 'advisory', workspaces: ['beta'], sendWorkspacePolicy: false,
  settleSeconds: 30, maxPerTick: 3, maxAttempts: 2,
  readinessNeedsAttention: true, readinessThreshold: 0.5,
  architecturalNeedsAttention: false, riskAttentionLevel: null, maxHoldMinutes: 60,
};

const ws = (id: number, name: string) => ({ id, name }) as Workspace;
const workspaces = [ws(1, 'alpha'), ws(2, 'beta'), ws(3, 'gamma')];

async function getApi() {
  const mod = await import('../../client/src/api.js');
  return mod.api as unknown as { getIntakeSettings: ReturnType<typeof vi.fn>; setIntakeSettings: ReturnType<typeof vi.fn> };
}

async function open(props: Partial<Parameters<typeof IntakeSettingsPanel>[0]> = {}) {
  const api = await getApi();
  api.getIntakeSettings.mockResolvedValue(saved);
  api.setIntakeSettings.mockResolvedValue(saved);
  render(<IntakeSettingsPanel workspaces={workspaces} onSaved={vi.fn()} onClose={vi.fn()} {...props} />);
  await screen.findByRole('dialog', { name: 'Task Intelligence settings' });
  return api;
}

describe('IntakeSettingsPanel', () => {
  beforeEach(async () => {
    const api = await getApi();
    api.getIntakeSettings.mockReset();
    api.setIntakeSettings.mockReset();
  });

  it('shows the opt-in count, saved opt-ins first, and a disabled Save until something changes', async () => {
    await open();
    expect(screen.getByText(/of 3 opted in/)).toHaveTextContent('1 of 3 opted in');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['beta', 'alpha', 'gamma']);
    expect(screen.getByRole('checkbox', { name: 'beta' })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText('Unsaved changes')).not.toBeInTheDocument();
  });

  it('saves the edited selection, keeping the untouched tuning fields', async () => {
    const onSaved = vi.fn();
    const onClose = vi.fn();
    const api = await open({ onSaved, onClose });
    const user = userEvent.setup();

    await user.click(screen.getByRole('checkbox', { name: 'gamma' }));
    await user.click(screen.getByRole('switch', { name: 'Send workspace policy' }));
    expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
    // tiles keep their order while editing — nothing jumps under the cursor
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['beta', 'alpha', 'gamma']);

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.setIntakeSettings).toHaveBeenCalledWith({ ...saved, workspaces: ['beta', 'gamma'], sendWorkspacePolicy: true });
    await waitFor(() => { expect(onSaved).toHaveBeenCalled(); expect(onClose).toHaveBeenCalled(); });
  });

  it('filters the tiles, and Select all / Clear act on the whole list', async () => {
    await open();
    const user = userEvent.setup();

    await user.type(screen.getByRole('searchbox', { name: 'Filter workspaces' }), 'gam');
    expect(screen.getAllByRole('checkbox').map((c) => c.getAttribute('aria-label'))).toEqual(['gamma']);
    await user.clear(screen.getByRole('searchbox', { name: 'Filter workspaces' }));

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getByText(/of 3 opted in/)).toHaveTextContent('3 of 3 opted in');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.getByText(/of 3 opted in/)).toHaveTextContent('0 of 3 opted in');
  });

  it('Off keeps the workspace selection and says so', async () => {
    const api = await open();
    const user = userEvent.setup();

    await user.click(screen.getByRole('button', { name: 'Off' }));
    expect(screen.getByRole('button', { name: 'Off' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Your workspace selection is kept/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(api.setIntakeSettings).toHaveBeenCalledWith({ ...saved, mode: 'off' });
  });

  it('Cancel closes without saving', async () => {
    const onClose = vi.fn();
    const api = await open({ onClose });
    await userEvent.setup().click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalled();
    expect(api.setIntakeSettings).not.toHaveBeenCalled();
  });
});
