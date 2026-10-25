import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ModelPricesPanel } from '../../client/src/components/ModelPricesPanel.js';

vi.mock('../../client/src/api.js', () => ({
  api: { getModelPrices: vi.fn(), setModelPrices: vi.fn() },
}));
import { api } from '../../client/src/api.js';
const mocked = api as unknown as Record<'getModelPrices' | 'setModelPrices', ReturnType<typeof vi.fn>>;

const SOL = { 'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 } };

describe('Agents › Prices tab', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocked.getModelPrices.mockResolvedValue({ prices: SOL });
    mocked.setModelPrices.mockImplementation(async (prices: unknown) => ({ prices }));
  });

  it('shows the stored prices and saves an edit as the whole table', async () => {
    render(<ModelPricesPanel onClose={() => {}} />);
    const cached = await screen.findByLabelText('gpt-6.1-sol cached input');
    expect(cached).toHaveValue('0.1');
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.clear(cached);
    await userEvent.type(cached, '0.25');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.setModelPrices).toHaveBeenCalledTimes(1));
    expect(mocked.setModelPrices.mock.calls[0]![0]).toEqual({ 'gpt-6.1-sol': { input: 2, cachedInput: 0.25, output: 10 } });
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('adds and removes models', async () => {
    render(<ModelPricesPanel onClose={() => {}} />);
    await screen.findByLabelText('gpt-6.1-sol input');
    await userEvent.click(screen.getByRole('button', { name: '+ Add model' }));
    await userEvent.type(screen.getByLabelText('New model id'), 'gpt-6-luna');
    await userEvent.type(screen.getByLabelText('gpt-6-luna input'), '0.5');
    await userEvent.type(screen.getByLabelText('gpt-6-luna cached input'), '0.05');
    await userEvent.type(screen.getByLabelText('gpt-6-luna output'), '2');
    await userEvent.click(screen.getByRole('button', { name: 'Remove gpt-6.1-sol' }));
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(mocked.setModelPrices).toHaveBeenCalledTimes(1));
    expect(mocked.setModelPrices.mock.calls[0]![0]).toEqual({ 'gpt-6-luna': { input: 0.5, cachedInput: 0.05, output: 2 } });
  });

  it('blocks saving an invalid or duplicate row', async () => {
    render(<ModelPricesPanel onClose={() => {}} />);
    const input = await screen.findByLabelText('gpt-6.1-sol input');
    await userEvent.clear(input);
    await userEvent.type(input, '-1');
    expect(screen.getByRole('alert')).toHaveTextContent(/non-negative/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();

    await userEvent.clear(input);
    await userEvent.type(input, '2');
    await userEvent.click(screen.getByRole('button', { name: '+ Add model' }));
    await userEvent.type(screen.getByLabelText('New model id'), 'gpt-6.1-sol');
    expect(screen.getByRole('alert')).toHaveTextContent(/more than once/);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
