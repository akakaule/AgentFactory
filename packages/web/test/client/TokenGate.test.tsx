import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const state = vi.hoisted(() => ({ token: null as string | null }));
vi.mock('../../client/src/api.js', () => ({
  api: { whoami: vi.fn() },
  getToken: () => state.token,
  setToken: (t: string | null) => { state.token = t; },
}));
import { api } from '../../client/src/api.js';
import { TokenGate } from '../../client/src/components/TokenGate.js';

describe('TokenGate — the browser signs in as a person, never as an agent', () => {
  beforeEach(() => { vi.clearAllMocks(); state.token = null; });

  it('refuses a service token, clears it, and says which token to use instead', async () => {
    vi.mocked(api.whoami).mockResolvedValue({ kind: 'service', label: 'otel-local' });
    const user = userEvent.setup();
    render(<TokenGate />);
    await user.type(screen.getByPlaceholderText('Access token'), 'svc-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    const err = await screen.findByText(/service token/);
    expect(err.textContent).toContain('otel-local');
    expect(err.textContent).toContain('--email');
    expect(state.token).toBeNull();
  });

  it('explains why it is shown when the stored token turned out to be a service token', () => {
    render(<TokenGate reason="This browser was signed in with the service token 'otel-local'." />);
    expect(screen.getByText(/signed in with the service token 'otel-local'/)).toBeTruthy();
  });

  it('accepts a user token', async () => {
    vi.mocked(api.whoami).mockResolvedValue({ kind: 'user', userId: 3, email: 'me@x' });
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    const user = userEvent.setup();
    render(<TokenGate />);
    await user.type(screen.getByPlaceholderText('Access token'), 'user-token');
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
    expect(state.token).toBe('user-token');
    vi.unstubAllGlobals();
  });
});
