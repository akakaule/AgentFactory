/** The slice of `process` the guard needs (a fake in tests). */
export interface CrashProcess {
  on(event: 'uncaughtException' | 'unhandledRejection', listener: (err: unknown) => void): unknown;
  exit(code: number): unknown;
}

/**
 * Windows does not kill a process's children when it dies, so a supervisor that crashes would
 * leave every worker or review session (and its MCP server) running unsupervised — and the stale-claim
 * reaper would later hand those tasks to a second worker. On a fatal error, kill the sessions
 * (`stop` tree-kills them synchronously), then exit non-zero as Node would have.
 */
export function installCrashGuard(name: string, stop: () => void, proc: CrashProcess = process, log: Pick<Console, 'error'> = console): void {
  let crashed = false;
  const fatal = (kind: string) => (err: unknown): void => {
    if (crashed) return;
    crashed = true;
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    log.error(`[${name}] ${kind}: ${detail} — killing in-flight sessions and exiting`);
    try {
      stop();
    } catch (e) {
      log.error(`[${name}] stopping sessions failed: ${(e as Error).message}`);
    }
    proc.exit(1);
  };
  proc.on('uncaughtException', fatal('uncaught exception'));
  proc.on('unhandledRejection', fatal('unhandled rejection'));
}
