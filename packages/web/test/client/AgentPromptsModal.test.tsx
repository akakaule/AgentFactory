import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentPromptsModal } from '../../client/src/components/AgentPromptsModal.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getAgentPrompts: vi.fn().mockResolvedValue({ reviewer: 'existing reviewer prompt' }),
    setAgentPrompts: vi.fn().mockResolvedValue({}),
  },
}));
import { api } from '../../client/src/api.js';

describe('AgentPromptsModal — global agent system prompts', () => {
  beforeEach(() => vi.clearAllMocks());

  it('renders in a wider modal shell for editing long prompts', async () => {
    render(<AgentPromptsModal onClose={() => {}} />);

    const dialog = await screen.findByRole('dialog', { name: 'Agent system prompts' });

    expect(dialog).toHaveStyle({ width: 'min(960px, 95vw)', maxWidth: 'none' });
  });

  it('loads the current global prompts and saves the edited values', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<AgentPromptsModal onClose={onClose} />);

    // pre-filled from getAgentPrompts, editable
    const reviewer = await screen.findByDisplayValue('existing reviewer prompt');
    await user.type(reviewer, ' — be extra critical');
    // a field with no stored value renders blank
    await user.type(screen.getByLabelText('Worker · Implementation'), 'write tests first');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.setAgentPrompts).toHaveBeenCalled());
    const sent = (api.setAgentPrompts as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, string>;
    expect(sent.reviewer).toBe('existing reviewer prompt — be extra critical');
    expect(sent['worker.implementation']).toBe('write tests first');
    expect(onClose).toHaveBeenCalled();
  });

  it('"Insert example" fills a field with the sample and Save sends it', async () => {
    const user = userEvent.setup();
    render(<AgentPromptsModal onClose={() => {}} />);
    await screen.findByDisplayValue('existing reviewer prompt'); // loaded

    // the Worker · Implementation field starts blank; its Insert-example button fills it
    const implField = screen.getByLabelText('Worker · Implementation') as HTMLTextAreaElement;
    expect(implField.value).toBe('');
    const buttons = screen.getAllByRole('button', { name: 'Insert example' });
    await user.click(buttons[2]!); // order: description, plan, implementation, reviewer, evaluator
    expect(implField.value).toContain('simplest change');

    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(api.setAgentPrompts).toHaveBeenCalled());
    const sent = (api.setAgentPrompts as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]![0] as Record<string, string>;
    expect(sent['worker.implementation']).toContain('simplest change');
  });
});
