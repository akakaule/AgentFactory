import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SupervisorSettingsModal } from '../../client/src/components/SupervisorSettingsModal.js';

vi.mock('../../client/src/api.js', () => ({
  api: {
    getSupervisorSettings: vi.fn().mockResolvedValue({
      dispatcher: { maxConcurrent: 3, stageEngines: { implementation: 'codex' } },
      reviewer: {},
      watcher: {},
    }),
    setSupervisorSettings: vi.fn().mockResolvedValue({}),
  },
}));
import { api } from '../../client/src/api.js';

describe('SupervisorSettingsModal', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads current settings, edits a field, and PUTs each kind (blank = inherit)', async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SupervisorSettingsModal onClose={onClose} />);

    // pre-filled from getSupervisorSettings (a dispatcher-only field, unambiguous)
    expect(((await screen.findByLabelText('Engine · implementation')) as HTMLSelectElement).value).toBe('codex');

    // edit a dispatcher-only field that started blank
    await user.type(screen.getByLabelText('Stale-claim minutes'), '200');
    await user.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() => expect(api.setSupervisorSettings).toHaveBeenCalledTimes(3)); // one PUT per kind
    const calls = (api.setSupervisorSettings as unknown as { mock: { calls: [string, Record<string, unknown>][] } }).mock.calls;
    const disp = calls.find((c) => c[0] === 'dispatcher')![1];
    expect(disp).toMatchObject({ maxConcurrent: 3, stageEngines: { implementation: 'codex' }, staleClaimMinutes: 200 });
    // reviewer/watcher untouched → empty sparse override (inherit the file config)
    expect(calls.find((c) => c[0] === 'reviewer')![1]).toEqual({});
    expect(onClose).toHaveBeenCalled();
  });
});
