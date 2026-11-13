import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { installCrashGuard } from '../src/crashGuard.js';

function fakeProcess() {
  const proc = Object.assign(new EventEmitter(), { exit: vi.fn() });
  return proc;
}

describe('installCrashGuard', () => {
  it.each(['uncaughtException', 'unhandledRejection'] as const)('on %s it kills the sessions, then exits non-zero', (event) => {
    const proc = fakeProcess();
    const order: string[] = [];
    const stop = vi.fn(() => order.push('stop'));
    proc.exit.mockImplementation(() => order.push('exit'));
    const log = { error: vi.fn() };
    installCrashGuard('reviewer', stop, proc, log);

    proc.emit(event, new Error('boom'));

    expect(order).toEqual(['stop', 'exit']);
    expect(proc.exit).toHaveBeenCalledWith(1);
    expect(log.error.mock.calls[0]![0]).toContain('boom');
  });

  it('still exits when stopping throws, and handles a second fault only once', () => {
    const proc = fakeProcess();
    const stop = vi.fn(() => { throw new Error('stop failed'); });
    installCrashGuard('reviewer', stop, proc, { error: vi.fn() });

    proc.emit('uncaughtException', new Error('first'));
    proc.emit('unhandledRejection', 'second');

    expect(stop).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledTimes(1);
    expect(proc.exit).toHaveBeenCalledWith(1);
  });
});
