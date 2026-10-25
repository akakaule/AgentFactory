import { InvalidTransitionError, parseRemoteUrl, resolveServedWorkspaces, type RemoteRef, type Task, type DeliveryFailingCheck, type DeliverySummary, type Status, type Workspace } from '@agentfactory/core';
import type { WatcherConfig } from './config.js';
import type { WatcherDeps } from './types.js';
import { makeGitHubProvider } from './providers/github.js';
import { makeAzdoProvider } from './providers/azdo.js';
import { ProviderHttpError, type DeliveryCheckResult, type DeliveryProviderApi, type PrObservation } from './providers/types.js';
import { resolveCredential } from './credentials.js';
import { makeAzdoWorkItems } from './providers/azdoWorkItems.js';
import { syncInbound, syncOutbound } from './adoSync.js';

const FULL_SHA = /^[0-9a-f]{40}([0-9a-f]{24})?$/;

/** HTTP statuses that mean "the credential is wrong", not "back off and retry" (see provider guards). */
const AUTH_STATUSES = new Set([203, 401, 403]);

/**
 * The watcher supervisor: polls every `delivering` task in its workspaces, opens the PR when the
 * approved branch has none (config.createPullRequests), observes the PR + pipeline on the task's
 * git host, and finishes the close the human approval started —
 * completes the current delivery when its PR merged, including during repair; `delivering → queued`
 * (with a failure/v1 comment carrying the failing checks or merge-conflict detail) when CI
 * failed, the PR has merge conflicts, or the PR was closed unmerged. Pure DB + REST — the one
 * local-git touch is the injected origin resolver, used
 * only to self-heal tasks dragged into delivering without an approve-seeded delivery row.
 *
 * Core records observations and reconciles merges atomically, retaining the actual check results.
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
  /** `<org>\0<token>` → the PAT owner's account, looked up once for the ADO work-item claim. */
  private adoIdentity = new Map<string, string>();

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
    const workspaces = await core.listWorkspaces();
    const served = resolveServedWorkspaces(workspaces.map((w) => w.name), {
      workspaces: this.config.workspaces,
      exclude: this.config.excludeWorkspaces,
    });
    const servedSet = new Set(served);
    const mine = (t: Task): boolean => servedSet.has(t.workspace);
    const tasks = (await core.listTasks()).filter(t => mine(t) && !t.archivedAt &&
      (t.status === 'delivering' || (t.delivery && ['queued', 'in_progress', 'blocked', 'in_review'].includes(t.status))));
    try {
      await core.recordSupervisorHeartbeat({
        name: this.config.name, kind: 'watcher', workspaces: served,
        inFlight: tasks.length, capacity: 0, pollSeconds: this.config.pollSeconds,
      });
    } catch (err) {
      console.warn('[watcher] heartbeat failed:', err);
    }
    if (this.deps.now() < this.pausedUntil) return; // provider rate limit — sit out this tick
    for (const t of tasks) {
      if (this.deps.now() < this.pausedUntil) return;
      // Per-task isolation: checkTask handles provider/transition errors itself, but a core
      // throw (e.g. the task was deleted between listTasks and here) must not abort the
      // remaining delivering tasks' checks for this tick.
      try {
        await this.checkTask(t.key);
      } catch (err) {
        console.error(`[watcher] ${t.key}: check failed:`, err);
      }
    }
    if (!this.config.syncWorkItems) return;
    for (const ws of workspaces) {
      if (!servedSet.has(ws.name) || !ws.adoSync?.enabled) continue;
      if (this.deps.now() < this.pausedUntil) return;
      await this.syncWorkItems(ws.name, ws.repoPath, ws.adoSync);
    }
  }

  /** One workspace's Azure DevOps work-item import + write-back (see adoSync.ts). Never throws. */
  private async syncWorkItems(workspace: string, repoPath: string, settings: NonNullable<Workspace['adoSync']>): Promise<void> {
    const { core, now } = this.deps;
    const key = `ado-sync:${workspace}`;
    if ((this.backoffUntil.get(key) ?? 0) > now()) return;
    const remote = this.remoteFor(this.repoFor({ workspace, repoPath }));
    if (remote?.provider !== 'azdo') {
      this.warnOnce(key, `[watcher] ${workspace}: the work-item import is enabled but the origin is not on Azure DevOps — skipping it`);
      return;
    }
    const cred = resolveCredential(this.deps.env, this.config.azdo.patEnv, workspace, await core.getWorkspacePat(workspace));
    const api = makeAzdoWorkItems({ fetchJson: this.deps.fetchJson, pat: cred.token, apiVersion: this.config.azdo.apiVersion });
    const project = { organization: remote.organization, project: remote.project };
    try {
      let assignee = settings.assignTo;
      if (!assignee) {
        const idKey = `${remote.organization}\0${cred.token ?? ''}`;
        assignee = this.adoIdentity.get(idKey) ?? (await api.whoAmI(project)) ?? '';
        if (!assignee) throw new Error('could not tell who owns the PAT — set "Assign to" in the workspace settings');
        this.adoIdentity.set(idKey, assignee);
      }
      const ctx = { core, api, workspace, project, settings, assignee, log: (m: string) => this.deps.console.log(`[watcher] ${workspace}: ${m}`) };
      await syncInbound(ctx);
      await syncOutbound(ctx);
      this.backoffLevel.delete(key);
    } catch (err) {
      this.noteFailure(key, err, cred, 'work-item sync');
    }
  }

  /** The machine-local clone for a task's workspace (#46 remote watch) — the board-central
   *  repoPath otherwise. `git remote get-url` must run against a repo on THIS machine. */
  private repoFor(detail: { workspace: string; repoPath: string }): string {
    return this.config.repoPathOverrides?.[detail.workspace] ?? detail.repoPath;
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

    const detail = await core.getTask(key);
    if (detail.archivedAt || !['delivering', 'queued', 'in_progress', 'blocked', 'in_review'].includes(detail.status)) return;
    let delivery = detail.delivery;

    // Self-heal a raw in_review → delivering drag: approve seeds the delivery row, a drag
    // bypasses it. Needs a branch and a recognizable origin; otherwise the task sits visibly
    // in Delivering with no chip and the human's Mark-done/Re-queue buttons stay the way out.
    if (!delivery) {
      if (detail.status !== 'delivering') return;
      const remote = this.remoteFor(this.repoFor(detail));
      if (!detail.branch || !remote) {
        this.warnOnce(key, `[watcher] ${key} is delivering but has ${detail.branch ? 'no recognizable origin' : 'no branch'} — a human must Mark done or Re-queue`);
        return;
      }
      const prUrl = [...detail.links].reverse().find((l) => l.kind === 'pr')?.url ?? null;
      delivery = await core.beginDelivery(key, { provider: remote.provider, branch: detail.branch, prUrl });
      console.log(`[watcher] ${key}: seeded delivery row (${remote.provider}, ${detail.branch})`);
    }

    const remote = this.remoteFor(this.repoFor(detail));
    if (!remote || remote.provider !== delivery.provider) {
      this.warnOnce(key, `[watcher] ${key}: workspace origin no longer matches its delivery provider (${delivery.provider}) — a human must Mark done or Re-queue`);
      return;
    }

    const prUrl = delivery.prUrl ?? [...detail.links].reverse().find((l) => l.kind === 'pr')?.url ?? null;
    // Resolve this workspace's credential (its stored PAT set in the board UI, else its own
    // <BASE>_<WORKSPACE> var, else the shared base) and build the provider bound to it — different
    // workspaces can live in different orgs/hosts.
    const cred = resolveCredential(
      this.deps.env,
      this.baseEnvVar(delivery.provider),
      detail.workspace,
      await this.deps.core.getWorkspacePat(detail.workspace),
    );
    const provider = this.buildProvider(delivery.provider, cred.token);
    let result: DeliveryCheckResult;
    try {
      result = await provider.check(remote, delivery.branch, prUrl, {
        postMergeChecks: this.config.postMergeChecks,
      });
    } catch (err) {
      this.noteFailure(key, err, cred);
      await this.recordCheckFailure(key, err, detail.status, delivery);
      return;
    }
    this.backoffUntil.delete(key);
    this.backoffLevel.delete(key);
    this.warned.delete(key);

    let { pr, checks } = result;
    // A closed PR this episode never attributed (no prUrl yet) belongs to an EARLIER delivery
    // episode — e.g. the PR a pr_closed bounce left behind before the re-approval. It must not
    // bounce this episode: treat it as no PR, so a fresh one is opened below.
    if (pr?.state === 'closed' && !delivery.prUrl) {
      pr = null;
      checks = { state: 'unknown', failing: [] };
    }
    // The worker pushes before review but never opens the PR (protocol v7): once the human
    // approved the implementation (delivering) and no PR exists, the watcher opens it.
    if (!pr && detail.status === 'delivering' && this.config.createPullRequests) {
      const opened = await this.openPr(key, detail, provider, remote, delivery.branch, cred);
      if (opened) {
        pr = opened;
        checks = { state: 'pending', failing: [] };
      }
    }
    const recorded = await core.recordDeliveryCheck(key, {
      expected: { status: detail.status, branch: delivery.branch, prUrl: delivery.prUrl, stateChangedAt: delivery.stateChangedAt },
      prUrl: pr?.url ?? null,
      prId: pr?.id ?? null,
      prState: pr ? pr.state : 'not_found',
      checksState: checks.state,
      failing: checks.failing,
      // the PR head as the host reports it: persisted next to the approved head, so a push after
      // approval marks the approved submission stale (only full SHAs — the board validates them)
      ...(pr?.headSha && FULL_SHA.test(pr.headSha) ? { headSha: pr.headSha } : {}),
    });
    if (recorded.skipped) return;
    if (recorded.changed) console.log(`[watcher] ${key}: ${pr ? `PR ${pr.id} ${pr.state}` : 'no PR found'} · checks ${checks.state}`);

    // Recording a merge already reconciles completion atomically in core. Never bounce a merged
    // PR for historical failed checks or ask a worker to implement the same delivery again.
    if (pr?.state === 'merged') return;
    // Only Delivering can bounce an open/closed PR; other states already have a repair owner.
    if (detail.status !== 'delivering') return;

    // Transitions run through core's assertTransition inside a transaction; racing a human
    // override throws InvalidTransitionError — the board already settled it, not an error.
    try {
      if (pr && pr.state === 'closed') {
        await core.failDelivery(key, {
          reason: 'pr_closed',
          detail: `PR ${pr.id} was closed without merging`,
          body: `PR: ${pr.url} (closed unmerged, head ${delivery.branch})\n\nThe branch still exists. If the close was intentional, a human should re-scope or archive this task; otherwise fix the work on the SAME branch — after the implementation review is approved again, a fresh PR is opened from it. Do not open a PR yourself.`,
        });
        console.log(`[watcher] ${key}: bounced — PR ${pr.id} closed without merge`);
      } else if (pr && pr.mergeConflict) {
        await core.failDelivery(key, {
          reason: 'merge_conflict',
          detail: `PR ${pr.id} has merge conflicts`,
          body: this.mergeConflictBody(pr.url, delivery.branch, pr.mergeConflict.detail),
        });
        console.log(`[watcher] ${key}: bounced — PR ${pr.id} has merge conflicts`);
      } else if (pr && checks.state === 'failing') {
        const names = checks.failing.map((f) => f.name).join(', ');
        const errors = await this.captureErrors(provider, remote, result);
        await core.failDelivery(key, {
          reason: 'ci_failed',
          detail: `PR ${pr.id} checks failed: ${names}`,
          body: this.ciFailureBody(pr.url, delivery.branch, checks.failing, errors),
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

  /**
   * Open the delivery's PR (title `<KEY>: <title>`, body = the worker's result summary). Returns
   * null when the host already has an open PR for the branch (picked up by the next poll's search)
   * or when creation failed — a failure is logged with the credential hint and backs the task off;
   * the board's "Open PR" link stays the manual fallback.
   */
  private async openPr(
    key: string,
    detail: { title: string; resultSummary: string | null },
    provider: DeliveryProviderApi,
    remote: RemoteRef,
    branch: string,
    cred: { envVar: string; base: string },
  ): Promise<PrObservation | null> {
    const summary = detail.resultSummary?.trim() || 'Implementation approved on the AgentFactory board.';
    try {
      const opened = await provider.openPullRequest(remote, {
        branch,
        title: `${key}: ${detail.title}`,
        body: `${summary}\n\n---\nOpened by AgentFactory for ${key} after its implementation review was approved.`,
      });
      this.deps.console.log(opened
        ? `[watcher] ${key}: opened PR ${opened.id} (${opened.url})`
        : `[watcher] ${key}: a PR for ${branch} already exists — picking it up on the next poll`);
      return opened;
    } catch (err) {
      this.noteFailure(key, err, cred, 'opening the PR');
      return null;
    }
  }

  private mergeConflictBody(prUrl: string, branch: string, detail: string | null): string {
    const problem = detail ? `\nMerge conflict detail: ${detail}` : '';
    return `PR: ${prUrl} (open, head ${branch})${problem}\n\nResolve the conflict: merge latest base branch into ${branch}, fix the conflicts, run verification, and push to the SAME branch - do not open a new PR.`;
  }

  private ciFailureBody(prUrl: string, branch: string, failing: DeliveryFailingCheck[], errors: string[]): string {
    const list = failing.map((f) => `- ${f.name}${f.url ? ` — ${f.url}` : ''}`).join('\n');
    // The concrete errors behind the red checks (build-log issues / check output) — this is what the
    // fixing worker acts on, so it doesn't have to go dig the CI log itself.
    const errorBlock = errors.length ? `\n\nBuild errors:\n\`\`\`text\n${errors.join('\n')}\n\`\`\`` : '';
    const instruction = 'The branch and PR still exist. Fix the failures and push to the SAME branch — do not open a new PR.';
    return `PR: ${prUrl} (open, head ${branch})\nFailing checks:\n${list}${errorBlock}\n\n${instruction}`;
  }

  /** Persist the failed poll as a provider revision observation, so the board shows unknown
   *  freshness during the outage (core keeps the known head: a proven mismatch stays stale), unless
   *  the delivery episode the poll started for has since changed.
   *  Best-effort — the backoff above already handles the retry. */
  private async recordCheckFailure(key: string, err: unknown, status: Status, delivery: DeliverySummary): Promise<void> {
    try {
      await this.deps.core.recordDeliveryCheckFailure(key, {
        error: `provider check failed: ${err instanceof Error ? err.message : String(err)}`.slice(0, 500),
        // fenced to the episode this poll was started for: a slow failure must not mark a newer
        // approval's freshness unknown
        expected: { status, branch: delivery.branch, prUrl: delivery.prUrl, stateChangedAt: delivery.stateChangedAt },
        ...(delivery.submissionId !== undefined ? { submissionId: delivery.submissionId } : {}),
      });
    } catch (recordErr) {
      this.deps.console.warn(`[watcher] ${key}: could not record the failed provider check (${recordErr instanceof Error ? recordErr.message : String(recordErr)})`);
    }
  }

  private noteFailure(key: string, err: unknown, cred?: { envVar: string; base: string }, what = 'provider check'): void {
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
      `[watcher] ${key}: ${what} failed (${err instanceof Error ? err.message : String(err)})${authHint} — backing off ${Math.round(delayMs / 1000)}s`,
    );
  }
}
