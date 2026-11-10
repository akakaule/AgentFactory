import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CredentialAlerts } from '../../client/src/components/CredentialAlerts.js';
import type { CredentialHealthView } from '../../client/src/types.js';

const view = (over: Partial<CredentialHealthView>): CredentialHealthView => ({
  workspace: 'kl-dis', state: 'ok', status: 'ok', checkedAt: '2026-10-30T14:00:00.000Z', failingSince: null,
  error: null, expiresAt: null, expiresInDays: null, ...over,
});

describe('CredentialAlerts', () => {
  it('raises a rejected PAT with the held work, and offers Update PAT and Check now', async () => {
    const onUpdatePat = vi.fn();
    const onCheck = vi.fn().mockResolvedValue(undefined);
    const user = userEvent.setup();
    render(<CredentialAlerts health={[view({ state: 'failing', status: 'failing', failingSince: '2026-10-30T13:50:00.000Z', error: "fatal: Authentication failed for 'https://dev.azure.com/x/'" })]}
      onUpdatePat={onUpdatePat} onCheck={onCheck} />);

    const alerts = screen.getByRole('region', { name: 'Credential alerts' });
    expect(alerts.textContent).toMatch(/kl-dis: the git host rejected the PAT since .+\. Implementation tasks are held\./);
    expect(screen.getByTitle(/Authentication failed/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Update PAT' }));
    expect(onUpdatePat).toHaveBeenCalledWith('kl-dis');
    await user.click(screen.getByRole('button', { name: 'Check now' }));
    expect(onCheck).toHaveBeenCalledWith('kl-dis');
  });

  it('warns about a PAT about to expire', () => {
    render(<CredentialAlerts health={[view({ workspace: 'nimbus', state: 'expiring', expiresAt: '2026-11-04T12:00:00.000Z', expiresInDays: 5 })]}
      onUpdatePat={vi.fn()} onCheck={vi.fn()} />);
    expect(screen.getByRole('region', { name: 'Credential alerts' }).textContent).toMatch(/nimbus: the PAT expires in 5 days \(.+\)\./);
  });

  it('shows nothing while every credential works or could not be checked', () => {
    const { container } = render(<CredentialAlerts health={[view({}), view({ workspace: 'b', state: 'unreachable', status: 'unreachable' })]}
      onUpdatePat={vi.fn()} onCheck={vi.fn()} />);
    expect(container.textContent).toBe('');
  });
});
