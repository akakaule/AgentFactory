/**
 * The board's git-credential monitor. A poll loop in the always-on web process that probes every
 * workspace's managed credential (core.checkCredential → `git ls-remote` with the injected PAT) at
 * start and every AF_CREDENTIAL_CHECK_MIN minutes (default 15; 0 turns it off). The recorded health
 * drives the board banner and holds implementation claims in a workspace whose PAT is failing.
 * Workspaces without a managed credential (ambient/ssh auth) answer null and are left alone.
 */

const DEFAULT_MINUTES = 15;

/** The slice of Core the monitor uses. */
export interface CredentialMonitorCore {
  listWorkspaces(): Array<{ name: string }>;
  checkCredential(workspace: string): Promise<{ workspace: string; state: string; error?: string | null } | null>;
}

export interface CredentialMonitorOptions {
  intervalMs: number;
  console?: Pick<Console, 'log' | 'warn' | 'error'>;
}

export function credentialCheckIntervalMs(env: Record<string, string | undefined>): number {
  const raw = env['AF_CREDENTIAL_CHECK_MIN'];
  const minutes = raw === undefined || raw.trim() === '' ? DEFAULT_MINUTES : Number(raw);
  if (!Number.isFinite(minutes) || minutes < 0) return DEFAULT_MINUTES * 60_000;
  return minutes * 60_000;
}

export class CredentialMonitor {
  private running = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly failing = new Set<string>();
  private readonly out: Pick<Console, 'log' | 'warn' | 'error'>;

  constructor(private readonly core: CredentialMonitorCore, private readonly opts: CredentialMonitorOptions) {
    this.out = opts.console ?? console;
  }

  /** One pass over every workspace, sequentially. A pass already in flight makes this a no-op. */
  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      for (const { name } of this.core.listWorkspaces()) {
        try {
          const health = await this.core.checkCredential(name);
          if (!health) continue;
          if (health.state === 'failing' && !this.failing.has(name)) {
            this.failing.add(name);
            this.out.warn(`[credentials] ${name}: the git host rejected the workspace credential — implementation work is held until it is fixed (${health.error ?? 'no detail'})`);
          } else if (health.state !== 'failing' && this.failing.delete(name)) {
            this.out.log(`[credentials] ${name}: the workspace credential works again`);
          }
        } catch (err) {
          this.out.error(`[credentials] ${name}: check failed — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.running = false;
    }
  }

  start(): void {
    if (this.opts.intervalMs <= 0 || this.timer) return;
    void this.runOnce();
    this.timer = setInterval(() => void this.runOnce(), this.opts.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
