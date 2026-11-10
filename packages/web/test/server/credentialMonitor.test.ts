import { describe, it, expect, vi } from 'vitest';
import { CredentialMonitor, credentialCheckIntervalMs } from '../../server/credentialMonitor.js';

const quiet = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe('CredentialMonitor', () => {
  it('checks every workspace in turn and keeps going when one check throws', async () => {
    const checked: string[] = [];
    const core = {
      listWorkspaces: () => [{ name: 'a' }, { name: 'b' }, { name: 'c' }],
      checkCredential: vi.fn(async (ws: string) => {
        checked.push(ws);
        if (ws === 'b') throw new Error('boom');
        return null;
      }),
    };
    await new CredentialMonitor(core, { intervalMs: 60_000, console: quiet }).runOnce();
    expect(checked).toEqual(['a', 'b', 'c']);
    expect(quiet.error).toHaveBeenCalledWith(expect.stringContaining('b'));
  });

  it('warns once when a credential starts failing and once when it recovers', async () => {
    const warn = vi.fn();
    const log = vi.fn();
    let state = 'failing';
    const core = {
      listWorkspaces: () => [{ name: 'kl-dis' }],
      checkCredential: async () => ({ workspace: 'kl-dis', state, error: 'fatal: Authentication failed' }),
    };
    const monitor = new CredentialMonitor(core, { intervalMs: 60_000, console: { ...quiet, warn, log } });
    await monitor.runOnce();
    await monitor.runOnce();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(/kl-dis.*rejected/);

    state = 'ok';
    await monitor.runOnce();
    expect(log).toHaveBeenCalledWith(expect.stringMatching(/kl-dis.*works again/));
  });

  it('does not overlap runs', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const core = { listWorkspaces: () => [{ name: 'a' }], checkCredential: vi.fn(async () => { await gate; return null; }) };
    const monitor = new CredentialMonitor(core, { intervalMs: 60_000, console: quiet });
    const first = monitor.runOnce();
    await monitor.runOnce(); // skipped while the first is in flight
    release();
    await first;
    expect(core.checkCredential).toHaveBeenCalledTimes(1);
  });
});

describe('credentialCheckIntervalMs', () => {
  it('defaults to 15 minutes, honours AF_CREDENTIAL_CHECK_MIN, and 0 turns the monitor off', () => {
    expect(credentialCheckIntervalMs({})).toBe(15 * 60_000);
    expect(credentialCheckIntervalMs({ AF_CREDENTIAL_CHECK_MIN: '5' })).toBe(5 * 60_000);
    expect(credentialCheckIntervalMs({ AF_CREDENTIAL_CHECK_MIN: '0' })).toBe(0);
    expect(credentialCheckIntervalMs({ AF_CREDENTIAL_CHECK_MIN: 'soon' })).toBe(15 * 60_000);
  });
});
