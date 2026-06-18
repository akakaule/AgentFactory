import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { SupervisorStrip } from '../../client/src/components/SupervisorStrip.js';

vi.mock('../../client/src/api.js', () => ({ api: { listSupervisors: vi.fn() } }));

async function mockSupervisors(value: unknown) {
  const mod = await import('../../client/src/api.js');
  (mod.api.listSupervisors as ReturnType<typeof vi.fn>).mockResolvedValue(value);
}

const sup = (over: Record<string, unknown> = {}) => ({
  name: 'dispatcher', kind: 'dispatcher', workspaces: ['default'], inFlight: 1, capacity: 2,
  pollSeconds: 15, polls: 9, version: null, startedAt: '', lastSeenAt: new Date().toISOString(),
  healthy: true, staleSeconds: 3, ...over,
});

describe('SupervisorStrip', () => {
  it('renders a healthy supervisor with its busy count', async () => {
    await mockSupervisors([sup()]);
    render(<SupervisorStrip />);
    expect(await screen.findByText('dispatcher')).toBeInTheDocument();
    expect(screen.getByText(/1\/2 busy/)).toBeInTheDocument();
  });

  it('shows a down marker for an unhealthy supervisor', async () => {
    await mockSupervisors([sup({ name: 'reviewer', kind: 'reviewer', healthy: false, staleSeconds: 120 })]);
    render(<SupervisorStrip />);
    expect(await screen.findByText('reviewer')).toBeInTheDocument();
    expect(screen.getByText(/down · 120s/)).toBeInTheDocument();
  });

  it('hints to start the dispatcher when none have reported', async () => {
    await mockSupervisors([]);
    render(<SupervisorStrip />);
    expect(await screen.findByText(/No supervisor has reported/)).toBeInTheDocument();
  });
});
