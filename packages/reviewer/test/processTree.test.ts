import { describe, expect, it, vi } from 'vitest';
import { terminateProcessTree, type ExecFileSyncFn } from '../src/processTree.js';
import type { SpawnedChild } from '../src/types.js';

function fakeChild(pid: number | undefined = 4321) {
  return {
    pid,
    stdout: null,
    stderr: null,
    on: vi.fn(),
    kill: vi.fn(() => true),
  } satisfies SpawnedChild;
}

describe('terminateProcessTree', () => {
  it('uses taskkill with an argument array to terminate the full Windows tree', () => {
    const child = fakeChild();
    const execFile = vi.fn<ExecFileSyncFn>();

    terminateProcessTree(child, 'SIGKILL', {
      platform: 'win32',
      systemRoot: 'C:\\Windows',
      execFile,
    });

    expect(execFile).toHaveBeenCalledWith(
      'C:\\Windows\\System32\\taskkill.exe',
      ['/PID', '4321', '/T', '/F'],
      { windowsHide: true, stdio: 'ignore', timeout: 10_000 },
    );
    expect(child.kill).not.toHaveBeenCalled();
  });

  it('uses the child signal directly outside Windows', () => {
    const child = fakeChild();
    const execFile = vi.fn<ExecFileSyncFn>();

    terminateProcessTree(child, 'SIGTERM', { platform: 'linux', systemRoot: 'C:\\Windows', execFile });

    expect(execFile).not.toHaveBeenCalled();
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
  });

  it('falls back to child.kill when taskkill fails or the pid is invalid', () => {
    const taskkillFailure: ExecFileSyncFn = () => { throw new Error('taskkill failed'); };
    const child = fakeChild();
    terminateProcessTree(child, 'SIGKILL', { platform: 'win32', systemRoot: 'C:\\Windows', execFile: taskkillFailure });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');

    const noPid = fakeChild(0);
    const execFile = vi.fn<ExecFileSyncFn>();
    terminateProcessTree(noPid, 'SIGKILL', { platform: 'win32', systemRoot: 'C:\\Windows', execFile });
    expect(execFile).not.toHaveBeenCalled();
    expect(noPid.kill).toHaveBeenCalledWith('SIGKILL');
  });
});
