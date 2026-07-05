import { InvalidTransitionError, parseRemoteUrl, resolveServedWorkspaces, type RemoteRef, type Task, type DeliveryFailingCheck } from '@agentfactory/core';
import type { WatcherConfig } from './config.js';
import type { WatcherDeps } from './types.js';
import { makeGitHubProvider } from './providers/github.js';
import { makeAzdoProvider } from './providers/azdo.js';
import { ProviderHttpError, type DeliveryCheckResult, type DeliveryProviderApi } from './providers/types.js';
import { resolveCredential } from './credentials.js';

/** HTTP statuses that mean "the credential is wrong", not "back off and retry" (see provider guards). */
const AUTH_STATUSES = new Set([203, 401, 403]);

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

  constructor(
    private readonly config: WatcherConfig,
    private readonly deps: WatcherDeps,
  ) {}

  /** The base credential env var name for a provider (the shared fallback; per-workspace overrides it). */
  private baseEnvVar(provider: 'github' | 'azdo'): string {
    return provider === 'github' ? this.config.github.tokenEnv : this.config.azdo.patEnv;
  }

  /** Build a provider bound to a specific token — rebuilt per task since the token varies by workspace. */
  private buildProvider(provider: 'github' | 'azdo', token: string | null): DeliveryProviderApi {
    return provider === 'github'
      ? makeGitHubProvider({ fetchJson: this.deps.fetchJson, token, apiBase: this.config.github.apiBase, now: this.deps.now })
      : makeAzdoProvider({ fetchJson: this.deps.fetchJson, pat: token, apiVersion: this.config.azdo.apiVersion });
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
    // Served set, re-read each tick: the explicit allowlist if set, else every DB workspace,
    // minus excludeWorkspaces — so a newly-created workspace is watched with no config edit.
    const served = resolveServedWorkspaces(core.listWorkspaces().map((w) => w.name), {
      workspaces: this.config.workspaces,
      exclude: this.config.excludeWorkspaces,
    });
    const servedSet = new Set(served);
    const mine = (t: Task): boolean => servedSet.has(t.workspace);
    const tasks = core.listTasks({ status: 'delivering' }).filter(mine);
    try {
      core.recordSupervisorHeartbeat({
        name: this.config.name, kind: 'watcher', workspaces: served,
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
    // Resolve this workspace's credential (its own <BASE>_<WORKSPACE> var, else the shared base),
    // and build the provider bound to it — different workspaces can live in different orgs/hosts.
    const cred = resolveCredential(this.deps.env, this.baseEnvVar(delivery.provider), detail.workspace);
    const provider = this.buildProvider(delivery.provider, cred.token);
    let result: DeliveryCheckResult;
    try {
      result = await provider.check(remote, delivery.branch, prUrl, {
        postMergeChecks: this.config.postMergeChecks,
      });
    } catch (err) {
      this.noteFailure(key, err, cred);
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
        const errors = await this.captureErrors(provider, remote, result);
        core.failDelivery(key, {
          reason: 'ci_failed',
          detail: `PR ${pr.id} checks failed: ${names}`,
          body: this.ciFailureBody(pr.url, pr.state, delivery.branch, checks.failing, errors),
        });
        console.log(`[watcher] ${key}: bounced — checks failed (${names})${errors.length ? ` · captured ${errors.length} error line(s)` : ''}`);
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

  /**
   * Best-effort error capture for the failing checks (gated by config.captureBuildErrors and whether
   * the provider implements it). Never throws to the tick — a capture failure just bounces with the
   * check names, which is the pre-existing behaviour.
   */
  private async captureErrors(provider: DeliveryProviderApi, remote: RemoteRef, result: DeliveryCheckResult): Promise<string[]> {
    if (!this.config.captureBuildErrors || !provider.describeFailures) return [];
    try {
      return await provider.describeFailures(remote, result, { postMergeChecks: this.config.postMergeChecks });
    } catch (err) {
      this.deps.console.warn(
        `[watcher] build-error capture failed (${err instanceof Error ? err.message : String(err)}) — bouncing with check names only`,
      );
      return [];
    }
  }

  private ciFailureBody(prUrl: string, prState: 'open' | 'merged' | 'closed', branch: string, failing: DeliveryFailingCheck[], errors: string[]): string {
    const list = failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`).join('\n');
    // The concrete errors behind the red checks (build-log issues / check output) — this is what the
    // fixing worker acts on, so it doesn't have to go dig the CI log itself.
    const errorBlock = errors.length ? `\n\nBuild errors:\n\`\`\`text\n${errors.join('\n')}\n\`\`\`` : '';
    const instruction =
      prState === 'merged'
        ? 'The PR is already merged but its checks are red. Fix the failures on a follow-up commit on the SAME branch and open a new PR.'
        : 'The branch and PR still exist. Fix the failures and push to the SAME branch — do not open a new PR.';
    return `PR: ${prUrl} (${prState}, head ${branch})\nFailing checks:\n${list}${errorBlock}\n\n${instruction}`;
  }

  private noteFailure(key: string, err: unknown, cred?: { envVar: string; base: string }): void {
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
    // An auth failure won't heal on retry — name the exact env var to set so the operator can act.
    const authHint =
      cred && err instanceof ProviderHttpError && AUTH_STATUSES.has(err.status)
        ? ` — set a valid credential in ${cred.envVar} (or the shared ${cred.base}) and restart the watcher`
        : '';
    console.warn(
      `[watcher] ${key}: provider check failed (${err instanceof Error ? err.message : String(err)})${authHint} — backing off ${Math.round(delayMs / 1000)}s`,
    );
  }
}
