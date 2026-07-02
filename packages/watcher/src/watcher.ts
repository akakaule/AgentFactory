import { InvalidTransitionError, parseRemoteUrl, type RemoteRef, type Task, type DeliveryFailingCheck } from '@agentfactory/core';
import type { WatcherConfig } from './config.js';
import type { WatcherDeps } from './types.js';
import { makeGitHubProvider } from './providers/github.js';
import { makeAzdoProvider } from './providers/azdo.js';
import { ProviderHttpError, type DeliveryCheckResult, type DeliveryProviderApi } from './providers/types.js';

/**
 * The watcher supervisor: polls every `delivering` task in its workspaces, observes the PR +
 * pipeline on the task's git host, and finishes the close the human approval started —
 * `delivering → done` when the PR merged and the checks came up green, `delivering → queued`
 * (with a failure/v1 comment carrying the failing checks) when CI failed or the PR was closed
 * unmerged. Pure DB + REST — the one local-git touch is the injected origin resolver, used
 * only to self-heal tasks dragged into delivering without an approve-seeded delivery row.
 *
 * Mirrors the Dispatcher's start/stop/safeTick shape minus all spawn/session machinery.
 */
export class Watcher {
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  /** Per-task error backoff (epoch ms gate + consecutive-failure level). */
  private backoffUntil = new Map<string, number>();
  private backoffLevel = new Map<string, number>();
  /** Provider-wide pause (rate limit) — epoch ms. */
  private pausedUntil = 0;
  /** Tasks warned about exactly once (no branch / unrecognizable origin) until their state changes. */
  private warned = new Set<string>();
  /** repoPath → parsed origin (or null); refreshed lazily, cached for the process lifetime. */
  private remoteCache = new Map<string, RemoteRef | null>();

  private readonly providers: Record<'github' | 'azdo', DeliveryProviderApi>;

  constructor(
    private readonly config: WatcherConfig,
    private readonly deps: WatcherDeps,
  ) {
    this.providers = {
      github: makeGitHubProvider({
        fetchJson: deps.fetchJson,
        token: deps.env[config.github.tokenEnv] ?? null,
        apiBase: config.github.apiBase,
        now: deps.now,
      }),
      azdo: makeAzdoProvider({
        fetchJson: deps.fetchJson,
        pat: deps.env[config.azdo.patEnv] ?? null,
        apiVersion: config.azdo.apiVersion,
      }),
    };
  }

  start(): void {
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.config.pollSeconds * 1000);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One tick; never overlaps itself and never lets an error kill the interval. */
  async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      this.deps.console.error('[watcher] tick failed:', err);
    } finally {
      this.ticking = false;
    }
  }

  async tick(): Promise<void> {
    const { core, console } = this.deps;
    const mine = (t: Task): boolean => this.config.workspaces.includes(t.workspace);
    const tasks = core.listTasks({ status: 'delivering' }).filter(mine);
    try {
      core.recordSupervisorHeartbeat({
        name: this.config.name, kind: 'watcher', workspaces: this.config.workspaces,
        inFlight: tasks.length, capacity: 0, pollSeconds: this.config.pollSeconds,
      });
    } catch (err) {
      console.warn('[watcher] heartbeat failed:', err);
    }
    if (this.deps.now() < this.pausedUntil) return; // provider rate limit — sit out this tick
    for (const t of tasks) {
      if (this.deps.now() < this.pausedUntil) return;
      await this.checkTask(t.key);
    }
  }

  private remoteFor(repoPath: string): RemoteRef | null {
    if (!this.remoteCache.has(repoPath)) {
      this.remoteCache.set(repoPath, parseRemoteUrl(this.deps.resolveOrigin(repoPath) ?? ''));
    }
    return this.remoteCache.get(repoPath) ?? null;
  }

  private warnOnce(key: string, msg: string): void {
    if (this.warned.has(key)) return;
    this.warned.add(key);
    this.deps.console.warn(msg);
  }

  private async checkTask(key: string): Promise<void> {
    const { core, console, now } = this.deps;
    if ((this.backoffUntil.get(key) ?? 0) > now()) return;

    const detail = core.getTask(key);
    let delivery = detail.delivery;

    // Self-heal a raw in_review → delivering drag: approve seeds the delivery row, a drag
    // bypasses it. Needs a branch and a recognizable origin; otherwise the task sits visibly
    // in Delivering with no chip and the human's Mark-done/Re-queue buttons stay the way out.
    if (!delivery) {
      const remote = this.remoteFor(detail.repoPath);
      if (!detail.branch || !remote) {
        this.warnOnce(key, `[watcher] ${key} is delivering but has ${detail.branch ? 'no recognizable origin' : 'no branch'} — a human must Mark done or Re-queue`);
        return;
      }
      const prUrl = [...detail.links].reverse().find((l) => l.kind === 'pr')?.url ?? null;
      delivery = core.beginDelivery(key, { provider: remote.provider, branch: detail.branch, prUrl });
      console.log(`[watcher] ${key}: seeded delivery row (${remote.provider}, ${detail.branch})`);
    }

    const remote = this.remoteFor(detail.repoPath);
    if (!remote || remote.provider !== delivery.provider) {
      this.warnOnce(key, `[watcher] ${key}: workspace origin no longer matches its delivery provider (${delivery.provider}) — a human must Mark done or Re-queue`);
      return;
    }

    const prUrl = delivery.prUrl ?? [...detail.links].reverse().find((l) => l.kind === 'pr')?.url ?? null;
    let result: DeliveryCheckResult;
    try {
      result = await this.providers[delivery.provider].check(remote, delivery.branch, prUrl, {
        postMergeChecks: this.config.postMergeChecks,
      });
    } catch (err) {
      this.noteFailure(key, err);
      return;
    }
    this.backoffUntil.delete(key);
    this.backoffLevel.delete(key);
    this.warned.delete(key);

    const { pr, checks } = result;
    const recorded = core.recordDeliveryCheck(key, {
      prUrl: pr?.url ?? null,
      prId: pr?.id ?? null,
      prState: pr ? pr.state : 'not_found',
      checksState: checks.state,
      failing: checks.failing,
    });
    if (recorded.changed) console.log(`[watcher] ${key}: ${pr ? `PR ${pr.id} ${pr.state}` : 'no PR found'} · checks ${checks.state}`);

    // Transitions run through core's assertTransition inside a transaction; racing a human
    // override throws InvalidTransitionError — the board already settled it, not an error.
    try {
      if (pr && pr.state === 'merged' && (checks.state === 'passing' || checks.state === 'none')) {
        core.completeDelivery(key, `PR ${pr.id} merged; checks ${checks.state === 'none' ? 'not configured' : 'green'}`);
        console.log(`[watcher] ${key}: delivered — PR ${pr.id} merged, checks ${checks.state}`);
      } else if (pr && pr.state === 'closed') {
        core.failDelivery(key, {
          reason: 'pr_closed',
          detail: `PR ${pr.id} was closed without merging`,
          body: `PR: ${pr.url} (closed unmerged, head ${delivery.branch})\n\nThe branch still exists. If the close was intentional, a human should re-scope or archive this task; otherwise fix and reopen a PR from the SAME branch.`,
        });
        console.log(`[watcher] ${key}: bounced — PR ${pr.id} closed without merge`);
      } else if (pr && checks.state === 'failing') {
        const names = checks.failing.map((f) => f.name).join(', ');
        core.failDelivery(key, {
          reason: 'ci_failed',
          detail: `PR ${pr.id} checks failed: ${names}`,
          body: this.ciFailureBody(pr.url, pr.state, delivery.branch, checks.failing),
        });
        console.log(`[watcher] ${key}: bounced — checks failed (${names})`);
      }
      // open + pending/passing/none/unknown, or no PR yet: recorded; keep waiting.
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        console.log(`[watcher] ${key}: raced a human move (${err.message}) — leaving as-is`);
      } else {
        throw err;
      }
    }
  }

  private ciFailureBody(prUrl: string, prState: 'open' | 'merged' | 'closed', branch: string, failing: DeliveryFailingCheck[]): string {
    const list = failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`).join('\n');
    const instruction =
      prState === 'merged'
        ? 'The PR is already merged but its checks are red. Fix the failures on a follow-up commit on the SAME branch and open a new PR.'
        : 'The branch and PR still exist. Fix the failures and push to the SAME branch — do not open a new PR.';
    return `PR: ${prUrl} (${prState}, head ${branch})\nFailing checks:\n${list}\n\n${instruction}`;
  }

  private noteFailure(key: string, err: unknown): void {
    const { console, now } = this.deps;
    if (err instanceof ProviderHttpError && err.pauseUntilMs !== null) {
      this.pausedUntil = Math.max(this.pausedUntil, err.pauseUntilMs);
      console.warn(`[watcher] rate limited — pausing all polling until ${new Date(this.pausedUntil).toISOString()}`);
      return;
    }
    const level = (this.backoffLevel.get(key) ?? 0) + 1;
    this.backoffLevel.set(key, level);
    const delayMs = Math.min(this.config.pollSeconds * 2 ** level, this.config.maxBackoffSeconds) * 1000;
    this.backoffUntil.set(key, now() + delayMs);
    console.warn(`[watcher] ${key}: provider check failed (${err instanceof Error ? err.message : String(err)}) — backing off ${Math.round(delayMs / 1000)}s`);
  }
}
