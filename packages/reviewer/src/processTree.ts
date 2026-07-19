import { execFileSync } from 'node:child_process';
import { win32 as win32Path } from 'node:path';
import type { SpawnedChild } from './types.js';

export type ExecFileSyncFn = (
  file: string,
  args: string[],
  options: { windowsHide: boolean; stdio: 'ignore'; timeout: number },
) => unknown;

interface ProcessTreeOptions {
  platform: NodeJS.Platform;
  systemRoot: string;
  execFile: ExecFileSyncFn;
}

/**
 * Terminate an engine and its descendants. Windows review engines may be launched through a
 * cmd.exe shim, so killing only the tracked child leaves Codex running as an orphan. taskkill's
 * `/T` flag closes that process tree; direct executable + argv invocation avoids shell parsing.
 */
export function terminateProcessTree(
  child: SpawnedChild,
  signal: NodeJS.Signals,
  overrides: Partial<ProcessTreeOptions> = {},
): void {
  const platform = overrides.platform ?? process.platform;
  const systemRoot = overrides.systemRoot ?? process.env['SystemRoot'] ?? 'C:\\Windows';
  const execFile: ExecFileSyncFn = overrides.execFile ?? ((file, args, options) => execFileSync(file, args, options));
  const pid = child.pid;

  if (platform === 'win32' && Number.isInteger(pid) && (pid ?? 0) > 0) {
    try {
      execFile(
        win32Path.join(systemRoot, 'System32', 'taskkill.exe'),
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore', timeout: 10_000 },
      );
      return;
    } catch {
      // The wrapper may already have exited, or taskkill may be unavailable. Fall back below.
    }
  }

  try {
    child.kill(signal);
  } catch {
    // Best-effort cleanup: the child may already be gone.
  }
}
