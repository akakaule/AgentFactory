import { resolve } from 'node:path';
import { buildFailureComment, refFromLabel, resolveServedWorkspaces, isPrFeedbackMarker, isFeedbackEvalMarker, parsePrFeedbackComment } from '@agentfactory/core';
import type { Task, TaskDetail, Stage, RetryReservation, EngineSettings } from '@agentfactory/core';
import { resolveEngine, defaultEngineSettings } from '@agentfactory/core';
import type { ReviewerConfig, ReviewEngine, ReasoningEffort, ReviewerProfile } from './config.js';
import { collectReview, combinedReview, reviewFingerprint, type ReviewRound } from './reviewRound.js';
import { createConsensus, collectBallot, consensusReview } from './consensus.js';
import { buildConsensusPrompt } from './consensusPrompt.js';
import type { ReviewerDeps, SpawnedChild, LogWriter } from './types.js';
import { buildEngineArgs } from './engine.js';
import { buildReviewPrompt, ensureMarker, buildFeedbackEvalPrompt, ensureFeedbackEvalMarker } from './review.js';
import { buildVisualizationPrompt, extractHtml, sanitizeMermaid, MAX_VISUALIZATION_BYTES } from './viz.js';
import type { BranchDiff } from '@agentfactory/core';

/** A session is one of three things: a review of a task's deliverable (`review` → ai-review/v1),
 *  an evaluation of a forwarded PR-review comment on a delivering task (`feedback-eval` →
 *  feedback-eval/v1), or the authoring of a task's HTML change-visualization (`visualize` →
 *  attachVisualization, no comment). */
type ReviewMode = 'review' | 'feedback-eval' | 'visualize';

/** Live state for one spawned review session. */
interface ReviewSession {
  label: string;
  workspace: string;
  key: string;
  stage: Stage;
  mode: ReviewMode;
  attempt: number;
  maxAttempts: number;
  reservationId: string;
  engine: ReviewEngine;
  child: SpawnedChild;
  logWriter: LogWriter;
  startedAtMs: number;
  /** codex final-message file (read for the verdict); null for claude (verdict = stdout). */
  outputFile: string | null;
  /** Accumulated stdout: the verdict for claude; the session transcript for codex. */
  stdout: string;
  /** Bounded tail of stdout+stderr for the transcript log. */
  logTail: string;
  settled: boolean;
  timedOut: boolean;
  round?: ReviewRound | undefined;
  deadlineTimer?: ReturnType<typeof setTimeout>;
  /** visualize sessions only: the vizAttempts budget key, pinned at spawn so a result submitted
   *  mid-session cannot shift it. */
  vizKey?: string | undefined;
}

const LOG_TAIL_CHARS = 4000;
const RETRY_RESERVATION_GRACE_MS = 30_000;

/**
 * The review supervisor. Polls the queue read-only for `in_review` tasks that still need a
 * review, spawns one fresh headless engine (codex/claude) per task with the prompt on STDIN,
 * and reaps each exit to post an `ai-review/v1` verdict via `add_comment`. The board's
 * add_comment hook does the rest: a clean doc-stage verdict auto-advances; findings and the
 * implementation stage escalate to the human gate. The reviewer is ADVISORY — it never
 * approves, requests changes, or changes status. All side effects are injected via deps.
 */
export class Reviewer {
  private readonly running = new Map<string, ReviewSession>(); // label -> session
  private readonly skipped = new Set<string>(); // task keys past maxAttempts

  private engineSettings: EngineSettings = defaultEngineSettings();

  private warnedNoEngine = false;
  /** Visualization budget, keyed `${key}@${latestResultAt}` — a new submission gets a fresh
   *  budget, and there is no skip-set for clearRestarted's failure-null forgiveness to resurrect. */
  /** Visualization retries are durable; this cache only supports the local diagnostic log. */
  private readonly vizAttempts = new Map<string, number>();
  private readonly engineCommands = new Map<ReviewEngine, string>(); // cached resolutions
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false; // re-entrancy guard (same shape as the watcher's)
  private stopping = false;
  /** In-flight async reaps kicked off by child exit/error events (awaited by tick()). */
  private readonly settling = new Set<Promise<void>>();

  constructor(
    private readonly config: ReviewerConfig,
    private readonly deps: ReviewerDeps,
  ) {}

  private get console(): Pick<Console, 'log' | 'warn' | 'error'> {
    return this.deps.console ?? console;
  }

  /** Begin polling on the configured interval. Runs one tick immediately. */
  start(): void {
    if (this.timer) return;
    this.stopping = false;
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.config.pollSeconds * 1000);
  }

  /** Stop polling and kill any in-flight reviews. */
  stop(): void {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const session of this.running.values()) {
      this.deps.terminateProcessTree(session.child, 'SIGTERM');
    }
  }

  /** One tick; never overlaps itself and never lets an error kill the interval. Without the
   *  guard, a `computeDiff`/`fetchRef` slower than pollSeconds let the next tick pass
   *  `hasRunningFor` (the session registers in `running` only after the diff) and spawn a
   *  duplicate review engine for the same task. */
  async safeTick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.tick();
    } catch (err) {
      this.console.error(`[reviewer] tick failed: ${(err as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** One poll cycle: enforce review timeouts, then start reviews for each workspace's free slots. */
  async tick(): Promise<void> {
    await Promise.all([...this.settling]); // exits since the last tick finish reaping first
    await this.refreshEngineSettings();
    await this.reconcileAbandonedReservations();
    await this.enforceTimeouts();
    const served = await this.servedWorkspaces();
    await this.recordHeartbeat(served);
    for (const workspace of served) await this.pollWorkspace(workspace);
    await Promise.all([...this.settling]); // exits fired during this tick too
  }

  /** Board engine toggles, read once per tick. A failed read keeps the previous tick's answer. */
  private async refreshEngineSettings(): Promise<void> {
    try {
      this.engineSettings = await this.deps.core.getEngineSettings();
    } catch (err) {
      this.console.warn(`[reviewer] could not read engine settings; keeping previous: ${(err as Error).message}`);
    }
  }

  /**
   * The engine (and the model that belongs to it) a session runs on right now: the configured
   * engine when the board has it enabled, else the other enabled engine on its default model
   * (a model name is meaningless to the other CLI), else null — nothing may run.
   */
  private engineChoice(configured: ReviewEngine, model: string | undefined): { engine: ReviewEngine; model: string | undefined } | null {
    const engine = resolveEngine(configured, this.engineSettings);
    if (!engine) { this.warnNoEngine(); return null; }
    this.warnedNoEngine = false;
    return engine === configured ? { engine, model } : { engine, model: undefined };
  }

  /** The configured reviewer profiles whose engine the board currently allows. */
  private activeReviewers(): ReviewerProfile[] | undefined {
    return this.config.reviewers?.filter((p) => this.engineSettings[p.engine].enabled);
  }

  private warnNoEngine(): void {
    if (this.warnedNoEngine) return;
    this.warnedNoEngine = true;
    this.console.warn('[reviewer] all agent engines are disabled on the board; leaving reviews untouched');
  }

  private async reconcileAbandonedReservations(): Promise<void> {
    if (!this.deps.core.reconcileAbandonedRetryReservations) return;
    try {
      await this.deps.core.reconcileAbandonedRetryReservations(RETRY_RESERVATION_GRACE_MS);
    } catch (err) {
      this.console.warn(`[reviewer] could not reconcile abandoned retry reservations: ${(err as Error).message}`);
    }
  }

  /** Run a child-exit reap in the background, tracked so tick() can await stragglers. */
  private trackReap(session: ReviewSession, code: number | null): void {
    const p = this.reap(session, code).catch((err) => {
      this.console.error(`[reviewer] reap of ${session.label} failed: ${(err as Error).message}`);
    });
    this.settling.add(p);
    void p.finally(() => this.settling.delete(p));
  }

  /**
   * The workspace slugs to watch this tick: the explicit `workspaces` allowlist if set, else every
   * workspace in the DB, minus `excludeWorkspaces`. Re-read each tick so a newly-created workspace
   * is reviewed automatically (opt-out model).
   */
  async servedWorkspaces(): Promise<string[]> {
    return resolveServedWorkspaces(
      (await this.deps.core.listWorkspaces()).map((w) => w.name),
      { workspaces: this.config.workspaces, exclude: this.config.excludeWorkspaces },
    );
  }

  /** Report a heartbeat so the board's health view knows the reviewer is alive. Best-effort. */
  private async recordHeartbeat(served: string[]): Promise<void> {
    try {
      await this.deps.core.recordSupervisorHeartbeat({
        name: this.config.name,
        kind: 'reviewer',
        workspaces: served,
        inFlight: this.running.size,
        capacity: this.config.maxConcurrent * served.length,
        pollSeconds: this.config.pollSeconds,
      });
    } catch {
      /* health is advisory — never let a heartbeat write break the poll loop */
    }
  }

  /** Number of live reviews currently serving a workspace. */
  runningCount(workspace?: string): number {
    if (workspace === undefined) return this.running.size;
    let n = 0;
    for (const s of this.running.values()) if (s.workspace === workspace) n += 1;
    return n;
  }

  /** True once a task has burned its attempts and is no longer reviewed. */
  isSkipListed(key: string): boolean {
    return this.skipped.has(key);
  }

  // -- timeouts --------------------------------------------------------------

  private async enforceTimeouts(): Promise<void> {
    const capMs = this.config.reviewMinutes * 60_000;
    const now = this.deps.now();
    for (const session of this.running.values()) {
      if (session.timedOut || session.settled) continue;
      if (now - session.startedAtMs > capMs || now >= (session.round?.deadlineMs ?? Infinity)) {
        // Codex writes --output-last-message only after completing its final answer. If that
        // artifact is already present at the polling boundary, keep the completed review and
        // merely terminate a wrapper/descendant that has not exited cleanly yet. Claude stdout
        // is streaming and may be partial, so it is intentionally not recovered this way.
        if (session.outputFile && this.readVerdict(session).trim()) {
          this.appendLog(session, `\n[reviewer] completed verdict found at timeout boundary; accepting and cleaning up process tree\n`);
          await this.reap(session, 0);
          this.deps.terminateProcessTree(session.child, 'SIGKILL');
          continue;
        }
        session.timedOut = true;
        this.appendLog(session, `\n[reviewer] review exceeded reviewMinutes (${this.config.reviewMinutes}m); killing\n`);
        this.deps.terminateProcessTree(session.child, 'SIGKILL');
      }
    }
  }

  // -- polling + spawning ----------------------------------------------------

  /** A task needs review iff no current AI review exists, or the latest is `pending` (superseded). */
  private needsReview(task: Task): boolean {
    return !task.aiReview || task.aiReview.verdict === 'pending';
  }

  private hasRunningFor(key: string): boolean {
    for (const s of this.running.values()) if (s.key === key) return true;
    return false;
  }

  /** A delivering task needs evaluation iff its latest pr-feedback/v1 has no later feedback-eval/v1. */
  private needsEval(detail: TaskDetail): boolean {
    let lastFeedback = -1;
    let lastEval = -1;
    detail.activity.forEach((a, i) => {
      if (a.type !== 'comment') return;
      if (isPrFeedbackMarker(a.body)) lastFeedback = i;
      if (isFeedbackEvalMarker(a.body)) lastEval = i;
    });
    return lastFeedback !== -1 && lastFeedback > lastEval;
  }

  /** `createdAt` of the latest result activity — the submission a visualization belongs to. */
  private latestResultAt(detail: TaskDetail): string {
    return detail.activity.filter((a) => a.type === 'result').at(-1)?.createdAt ?? '';
  }

  /** A task needs a visualization iff it has a diffable implementation deliverable and no
   *  visualization generated since the latest submission (both timestamps are nowIso() strings,
   *  so lexicographic order is chronological order). */
  private needsVisualization(detail: TaskDetail): boolean {
    if (detail.stage !== 'implementation') return false;
    if (this.resolveBranch(detail) === null) return false;
    return detail.visualizationGeneratedAt === null || detail.visualizationGeneratedAt < this.latestResultAt(detail);
  }

  private vizKeyFor(detail: TaskDetail): string {
    return `${detail.key}@${this.latestResultAt(detail)}`;
  }

  private async pollWorkspace(workspace: string): Promise<void> {
    let slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
    const inReview = await this.deps.core.listTasks({ status: 'in_review', workspace });
    this.clearRestarted(inReview);

    // Visualization pass FIRST, so the page exists by the time the verdict posts (hasRunningFor
    // serialises per key: viz this tick, review next tick, link line on the verdict). Deliberately
    // ignores the review skip-list — a task left for a human reviewer wants the page most.
    if (this.config.visualization.enabled) {
      for (const task of inReview) {
        if (slots <= 0) break;
        if (this.hasRunningFor(task.key)) continue;
        const detail = await this.deps.core.getTask(task.key);
        if (!this.needsVisualization(detail)) continue;
        if (await this.startVisualization(workspace, task.key)) slots -= 1;
      }
    }

    for (const task of inReview) {
      if (slots <= 0) break;
      if (this.skipped.has(task.key)) continue;
      if (this.hasRunningFor(task.key)) continue; // already reviewing this cycle
      if (!this.needsReview(task)) continue; // already has a current verdict
      if (await this.startReview(workspace, task.key)) slots -= 1;
    }

    // Delivering-feedback evaluation: a human forwarded a PR-review comment (pr-feedback/v1) onto a
    // delivering task — critically evaluate it and post a feedback-eval/v1 verdict.
    slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
    const delivering = await this.deps.core.listTasks({ status: 'delivering', workspace });
    this.clearRestarted(delivering);
    for (const task of delivering) {
      if (slots <= 0) break;
      if (this.skipped.has(task.key)) continue;
      if (this.hasRunningFor(task.key)) continue;
      if (!this.needsEval(await this.deps.core.getTask(task.key))) continue;
      if (await this.startReview(workspace, task.key, 'feedback-eval')) slots -= 1;
    }
  }

  /** A restart/v1 marker clears the derived failure; forgive the matching in-memory budget. */
  private clearRestarted(tasks: Task[]): void {
    for (const task of tasks) {
      if (!this.skipped.has(task.key) || task.failure !== null) continue;
      this.skipped.delete(task.key);
      this.console.log(`[reviewer] ${task.key} restarted by operator — attempt budget reset`);
    }
  }

  private resolveCommand(engine: ReviewEngine): string {
    let cmd = this.engineCommands.get(engine);
    if (cmd === undefined) {
      cmd = this.deps.resolveEngine(engine);
      this.engineCommands.set(engine, cmd);
    }
    return cmd;
  }

  /**
   * Bind a spawned review's token usage to its task for OTLP export. Engine-specific:
   * `claude` reads OTLP from the environment (so we set the full env, plus a `task.key`/
   * `af.workspace`/`af.worker` resource attribute); `codex` gets its exporter injected as a
   * `-c otel.exporter=...` override in buildEngineArgs (codex does not interpolate env vars
   * into config.toml headers) — the AF_TASK_KEY/AF_OTEL_TOKEN env vars remain as session
   * markers only.
   */
  private applyOtel(env: NodeJS.ProcessEnv, engine: ReviewEngine, key: string, workspace: string, label: string): void {
    const otel = this.config.otel;
    if (!otel) return;
    if (engine === 'claude') {
      env['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1';
      env['OTEL_LOGS_EXPORTER'] = 'otlp';
      env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json';
      env['OTEL_EXPORTER_OTLP_ENDPOINT'] = otel.endpoint;
      if (otel.token) env['OTEL_EXPORTER_OTLP_HEADERS'] = `Authorization=Bearer ${otel.token}`;
      env['OTEL_RESOURCE_ATTRIBUTES'] = `task.key=${key},af.workspace=${workspace},af.worker=${label}`;
    } else {
      env['AF_TASK_KEY'] = key;
      if (otel.token) env['AF_OTEL_TOKEN'] = otel.token;
    }
  }

  /** The machine-local clone for a task's workspace (#46 remote review) — the board-central
   *  repoPath otherwise. Diffs and fetches always run against local git. */
  private repoFor(detail: { workspace: string; repoPath: string }): string {
    return this.config.repoPathOverrides?.[detail.workspace] ?? detail.repoPath;
  }

  /** Branch to diff: the last branch-kind link (as the board's diff view uses), else the named branch. */
  private resolveBranch(detail: TaskDetail): string | null {
    const link = detail.links.filter((l) => l.kind === 'branch').at(-1);
    // The label may be decorated (e.g. "feature/x (PR 4703 source — …)"); recover the bare
    // ref so the annotation never reaches git. Keep the raw label as the fallback so a truly
    // unparseable label still fails loudly in branchDiff, exactly as before.
    if (link) return refFromLabel(link.label) ?? link.label;
    return detail.branch ?? null;
  }

  /** Resolve + compute the task's deliverable diff (shared by review and visualize sessions).
   *  A pr-review task's branch link is a teammate's PR head, not in the local store: fetch it
   *  into origin/<head> and diff that. resolveBaseRef already yields origin/<default>, so the
   *  diff is origin/<base>...origin/<head> (default-base PRs; the producer skips others). */
  private async prepareDiff(detail: TaskDetail): Promise<{ diffRef: string; diff: BranchDiff }> {
    const branch = this.resolveBranch(detail);
    if (!branch) throw new Error(`no branch recorded to diff`);
    let diffRef = branch;
    if (detail.kind === 'pr-review') {
      await this.deps.fetchRef(this.repoFor(detail), branch);
      diffRef = `origin/${branch}`;
    }
    const diff = await this.deps.computeDiff(this.repoFor(detail), diffRef);
    return { diffRef, diff };
  }

  /** Build the prompt + spawn one review/evaluation; returns false (no slot consumed) on a pre-spawn failure. */
  private async startReview(workspace: string, key: string, mode: ReviewMode = 'review'): Promise<boolean> {
    // Board engine toggles (read each tick). With `reviewers` configured, a review round runs the
    // members whose engine is enabled — a single remaining member reviews alone, no round; the
    // single-engine and feedback-eval paths fall back to the other engine on its default model.
    let engine: ReviewEngine;
    let model = this.config.model;
    let reasoningEffort: ReasoningEffort | undefined;
    let members = mode === 'review' ? this.activeReviewers() : undefined;
    if (members && members.length === 0) { this.warnNoEngine(); return false; }
    if (members && members.length === 1) {
      const solo = members[0]!;
      ({ engine, model, reasoningEffort } = solo);
      const off = this.config.reviewers!.filter((p) => !this.engineSettings[p.engine].enabled).map((p) => p.engine);
      this.console.log(`[reviewer] ${key}: ${[...new Set(off)].join(', ')} disabled on the board; single-reviewer mode via ${engine}`);
      members = undefined;
    } else if (members) {
      engine = this.config.engine;
      this.warnedNoEngine = false;
    } else {
      const choice = this.engineChoice(this.config.engine, this.config.model);
      if (!choice) return false;
      if (choice.engine !== this.config.engine) this.console.log(`[reviewer] ${key}: ${this.config.engine} disabled on the board; falling back to ${choice.engine} for ${mode}`);
      ({ engine, model } = choice);
    }
    const deadlineMs = this.config.consensus?.enabled ? this.deps.now() + this.config.consensus.totalMinutes * 60000 : undefined;
    let prompt: string;
    let stage: Stage;
    let round: ReviewRound | undefined;
    let detail: TaskDetail;
    try {
      detail = await this.deps.core.getTask(key);
      stage = detail.stage;
    } catch (err) {
      this.console.error(`[reviewer] could not load ${key}: ${(err as Error).message}`);
      return false;
    }
    const operation = mode === 'feedback-eval' ? 'reviewer:feedback-eval' : `reviewer:${stage}`;
    const reservation = await this.deps.core.reserveRetry(key, { operation, maxAttempts: this.config.maxAttempts });
    if (reservation === null) {
      this.skipList(key);
      return false;
    }
    const attempt = reservation.attempt;
    try {
      if (mode === 'feedback-eval') {
        // critically evaluate the latest forwarded PR-review comment against the branch diff
        const systemPrompt = await this.deps.core.resolveAgentPrompt('delivering-evaluator', detail.workspace);
        const branch = this.resolveBranch(detail);
        if (!branch) throw new Error('no branch recorded to diff');
        const feedback = [...detail.activity.filter((a) => a.type === 'comment')].reverse()
          .map((a) => parsePrFeedbackComment(a.body)).find((p) => p !== null);
        if (!feedback) throw new Error('no pr-feedback to evaluate');
        const diff = await this.deps.computeDiff(this.repoFor(detail), branch);
        prompt = buildFeedbackEvalPrompt({ task: detail, engine, feedback: feedback.feedback, branch, diff, maxDiffChars: this.config.maxDiffChars, systemPrompt });
      } else {
        // the configured reviewer system prompt (workspace override → global default → ''), inlined
        const systemPrompt = await this.deps.core.resolveAgentPrompt('reviewer', detail.workspace);
        let makePrompt: (reviewEngine: ReviewEngine) => string;
        let revision: ReviewRound['revision'];
        if (detail.stage === 'implementation') {
          const { diffRef, diff } = await this.prepareDiff(detail);
          if (this.config.consensus?.enabled) {
            if (!diff.headSha || !diff.baseSha) throw new Error('consensus requires immutable review revisions');
            revision = { headSha: diff.headSha, baseSha: diff.baseSha };
          }
          makePrompt = (reviewEngine) => buildReviewPrompt({ task: detail, engine: reviewEngine,
            branch: revision ? `${diffRef}\nRepository: ${this.repoFor(detail)}\nPinned head: ${revision.headSha}\nPinned base tip: ${revision.baseSha}\nInspect these immutable commits with git show; do not inspect the current working tree or edit files.` : diffRef,
            diff, maxDiffChars: this.config.maxDiffChars, systemPrompt });
        } else {
          makePrompt = (reviewEngine) => buildReviewPrompt({ task: detail, engine: reviewEngine,
            repoPath: resolve(this.repoFor(detail)), maxDiffChars: this.config.maxDiffChars, systemPrompt });
        }
        prompt = makePrompt(engine);
        if (members) round = {
          fingerprint: reviewFingerprint(detail),
          members: members.map((profile) => ({ profile, prompt: makePrompt(profile.engine) })),
          results: [],
          ...(deadlineMs !== undefined ? { deadlineMs } : {}),
          ...(revision ? { revision } : {}),
        };
      }
    } catch (err) {
      // Couldn't prepare the review (no branch, diff failed, task vanished) — burn an attempt.
      await this.burnAttempt(key, attempt, reservation.maxAttempts, `could not prepare ${mode}: ${(err as Error).message}`, reservation.id);
      return false;
    }

    if (round) {
      try { this.launchRoundMember(workspace, key, stage, attempt, { maxAttempts: reservation.maxAttempts, reservationId: reservation.id }, round); }
      catch (err) { await this.burnAttempt(key, attempt, reservation.maxAttempts, `could not launch review: ${(err as Error).message}`, reservation.id); return false; }
      return true;
    }
    const label = `${workspace}#${key}-r${attempt}`;
    const fileBase = `${this.deps.logDir}/${key}-review-${attempt}`;
    this.launchSession({ workspace, key, stage, mode, attempt, maxAttempts: reservation.maxAttempts, reservationId: reservation.id, engine, model, reasoningEffort, prompt, label, fileBase });
    this.console.log(`[reviewer] ${mode === 'feedback-eval' ? 'evaluating feedback on' : 'reviewing'} ${key} (${stage}) via ${engine} — ${label}, log ${fileBase}.log`);
    return true;
  }

  private launchRoundMember(workspace: string, key: string, stage: Stage, attempt: number, budget: { maxAttempts: number; reservationId: string }, round: ReviewRound): void {
    if (this.deps.now() >= (round.deadlineMs ?? Infinity)) throw new Error('consensus total deadline exceeded');
    const index = round.consensus ? round.consensus.ballots.length : round.results.length;
    const member = round.members[index]!;
    const { engine, model, reasoningEffort } = member.profile;
    const phase = round.consensus?.phase ?? 'discovery';
    const suffix = `r${attempt}-${index + 1}-${engine}${round.deadlineMs !== undefined ? `-${phase}` : ''}`;
    const prompt = round.consensus ? buildConsensusPrompt(member.prompt, round.consensus, this.config.consensus?.maxPromptChars) : member.prompt;
    if (round.deadlineMs !== undefined && prompt.length > this.config.consensus!.maxPromptChars) throw new Error('consensus prompt exceeds configured limit');
    this.launchSession({ workspace, key, stage, mode: 'review', attempt, maxAttempts: budget.maxAttempts, reservationId: budget.reservationId, engine, model, reasoningEffort,
      prompt, label: `${workspace}#${key}-${suffix}`, fileBase: `${this.deps.logDir}/${key}-review-${suffix}`, round });
    this.console.log(`[reviewer] reviewing ${key} (${stage}, ${phase}) via ${engine}/${model ?? 'default'}${reasoningEffort ? ` (${reasoningEffort})` : ''}, reviewer ${index + 1}/${round.members.length}`);
  }

  /** Author the task's HTML change-visualization in one extra engine session; returns false
   *  (no slot consumed) on a pre-spawn failure. Failures are log-only (burnVizAttempt) — they
   *  never post a comment and never touch the review budget. */
  private async startVisualization(workspace: string, key: string): Promise<boolean> {
    let detail: TaskDetail;
    try {
      detail = await this.deps.core.getTask(key);
    } catch (err) {
      this.console.error(`[reviewer] could not load ${key} for visualization: ${(err as Error).message}`);
      return false;
    }
    if (!this.needsVisualization(detail)) return false; // superseded between list and load
    const vizKey = this.vizKeyFor(detail);
    const configured = this.config.visualization.engine ?? this.config.engine;
    const choice = this.engineChoice(configured, this.config.visualization.model ?? this.config.model);
    if (!choice) return false; // nothing may run; the review pass decides for itself
    if (choice.engine !== configured) this.console.log(`[reviewer] ${key}: ${configured} disabled on the board; visualizing via ${choice.engine}`);
    const { engine, model } = choice;
    let prompt: string;
    try {
      const { diffRef, diff } = await this.prepareDiff(detail);
      prompt = buildVisualizationPrompt({ task: detail, branch: diffRef, diff, maxDiffChars: this.config.maxDiffChars });
    } catch (err) {
      const attempt = (this.vizAttempts.get(vizKey) ?? 0) + 1;
      this.burnVizAttempt(key, vizKey, attempt, this.config.maxAttempts, `could not prepare visualization: ${(err as Error).message}`);
      return false;
    }

    const reservation = await this.deps.core.reserveRetry(key, { operation: `visualization:${vizKey}`, maxAttempts: this.config.maxAttempts });
    if (reservation === null) return false;
    const attempt = reservation.attempt;

    const label = `${workspace}#${key}-viz${attempt}`;
    const fileBase = `${this.deps.logDir}/${key}-viz-${attempt}`;
    this.launchSession({ workspace, key, stage: detail.stage, mode: 'visualize', attempt, maxAttempts: reservation.maxAttempts, reservationId: reservation.id, engine, model, prompt, label, fileBase, vizKey });
    this.console.log(`[reviewer] visualizing ${key} via ${engine} — ${label}, log ${fileBase}.log`);
    return true;
  }

  /** Spawn one engine session and register it — the shared tail of every session kind. */
  private launchSession(opts: {
    workspace: string;
    key: string;
    stage: Stage;
    mode: ReviewMode;
    attempt: number;
    maxAttempts: number;
    reservationId: string;
    engine: ReviewEngine;
    model: string | undefined;
    reasoningEffort?: ReasoningEffort | undefined;
    round?: ReviewRound | undefined;
    prompt: string;
    label: string;
    /** Log/output path base: `${fileBase}.log` + (codex) `${fileBase}.out`. */
    fileBase: string;
    vizKey?: string | undefined;
  }): void {
    const { workspace, key, stage, mode, attempt, maxAttempts, reservationId, engine, model, prompt, label, fileBase, vizKey } = opts;
    const outputFile = engine === 'codex' ? `${fileBase}.out` : null;
    if (outputFile) this.deps.clearOutput(outputFile);
    const logWriter = this.deps.openLog(`${fileBase}.log`);
    const args = buildEngineArgs({
      engine,
      model,
      reasoningEffort: opts.reasoningEffort,
      outputFile: outputFile ?? '',
      otel: this.config.otel ? { endpoint: this.config.otel.endpoint, taskKey: key, token: this.config.otel.token, worker: label, workspace } : undefined,
    });
    const env: NodeJS.ProcessEnv = { ...(this.deps.baseEnv ?? {}) };
    if (this.config.otel) this.applyOtel(env, engine, key, workspace, label);

    const child = this.deps.spawn({ command: this.resolveCommand(engine), args, cwd: this.deps.logDir, env, stdin: prompt });
    const session: ReviewSession = {
      label,
      workspace,
      key,
      stage,
      mode,
      attempt,
      maxAttempts,
      reservationId,
      engine,
      child,
      logWriter,
      startedAtMs: this.deps.now(),
      outputFile,
      stdout: '',
      logTail: '',
      settled: false,
      timedOut: false,
      round: opts.round,
      vizKey,
    };
    this.running.set(label, session);
    void Promise.resolve(this.deps.core.settleRetry(reservationId, { state: 'running' })).catch((err) => {
      this.console.warn(`[reviewer] could not mark ${label} running: ${(err as Error).message}`);
    });

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      session.stdout += text;
      this.appendLog(session, text);
    });
    child.stderr?.on('data', (chunk) => this.appendLog(session, chunk.toString()));
    child.on('error', (err) => {
      this.appendLog(session, `\n[reviewer] spawn error: ${err.message}\n`);
      this.trackReap(session, null);
    });
    child.on('exit', (code) => this.trackReap(session, code));
    if (opts.round?.deadlineMs !== undefined) {
      const remaining = Math.min(this.config.reviewMinutes * 60000, opts.round.deadlineMs - this.deps.now());
      session.deadlineTimer = setTimeout(() => {
        if (session.settled) return;
        session.timedOut = true;
        this.deps.terminateProcessTree(child, 'SIGKILL');
      }, Math.max(0, remaining));
      session.deadlineTimer.unref();
    }
  }

  private appendLog(session: ReviewSession, text: string): void {
    session.logWriter.write(text);
    session.logTail = (session.logTail + text).slice(-LOG_TAIL_CHARS);
  }

  // -- reaping ---------------------------------------------------------------

  /** CLI errors are not review JSON, even when a wrapper exits zero. Codex final-file
   * recovery keeps its existing semantics; Claude streaming output is not that artifact. */
  private claudeFailure(session: ReviewSession, code: number | null, output: string): string | null {
    if (session.engine !== 'claude') return null;
    const errorLine = output.trimStart().match(/^Error:[^\r\n]*/i)?.[0];
    if (code === 0 && !errorLine) return null;
    const detail = errorLine ?? session.logTail.match(/^Error:[^\r\n]*/im)?.[0];
    return `claude ${code === 0 ? 'failed' : `exited code ${code ?? 'null'}`}${detail ? `: ${detail.slice(0,500)}` : ''}`;
  }

  /** Handle a review exit: read the verdict and post it, or burn an attempt on failure.
   *  The session HOLDS its `running` slot (and its hasRunningFor guard) until the reap fully
   *  settles — freeing it at entry let pollWorkspace start a same-attempt duplicate review
   *  while the verdict/failure writes were still in flight. */
  private async reap(session: ReviewSession, code: number | null): Promise<void> {
    if (session.settled) return;
    session.settled = true;
    try {
      await this.reapSettled(session, code);
    } finally {
      this.running.delete(session.label);
    }
  }

  private async reapSettled(session: ReviewSession, code: number | null): Promise<void> {
    if (session.deadlineTimer) clearTimeout(session.deadlineTimer);
    session.logWriter.end();
    if (session.mode === 'visualize') return this.reapVisualization(session, code);

    if (session.round) {
      const detail = await this.deps.core.getTask(session.key);
      if (this.stopping || detail.status !== 'in_review' || !this.needsReview(detail)
        || reviewFingerprint(detail) !== session.round.fingerprint) {
        this.console.log(`[reviewer] discarded superseded/stopped review round for ${session.key}`);
        return;
      }
    }

    const verdict = this.readVerdict(session);
    if (this.deps.now() >= (session.round?.deadlineMs ?? Infinity)) {
      await this.burnAttempt(session.key, session.attempt, session.maxAttempts, 'consensus total deadline exceeded', session.reservationId);
      return;
    }
    const completedCodexVerdict = session.outputFile !== null && verdict.trim().length > 0;
    if (session.timedOut && !completedCodexVerdict) {
      await this.burnAttempt(session.key, session.attempt, session.maxAttempts, `timed out after ${this.config.reviewMinutes}m`, session.reservationId);
      return;
    }

    if (session.round?.deadlineMs !== undefined && code !== 0 && !session.timedOut) {
      await this.burnAttempt(session.key, session.attempt, session.maxAttempts, `${session.engine} exited code ${code ?? 'null'} during consensus`, session.reservationId);
      return;
    }

    const cliFailure = this.claudeFailure(session, code, verdict);
    if (cliFailure) {
      await this.burnAttempt(session.key, session.attempt, session.maxAttempts, cliFailure, session.reservationId);
      return;
    }

    if (!verdict.trim()) {
      const reason = code === 0 ? 'engine produced no verdict' : `engine exited code ${code ?? 'null'} with no verdict`;
      await this.burnAttempt(session.key, session.attempt, session.maxAttempts, reason, session.reservationId);
      return;
    }

    if (session.timedOut) {
      this.console.log(`[reviewer] accepting completed verdict for ${session.key} found while terminating timed-out process tree`);
    }

    let body = session.mode === 'feedback-eval' ? ensureFeedbackEvalMarker(verdict) : ensureMarker(verdict, session.engine);
    if (session.round) {
      try {
        if (session.round.consensus) collectBallot(session.round.consensus, verdict);
        else collectReview(session.round, verdict);
        if (session.round.results.length < session.round.members.length) {
          this.launchRoundMember(session.workspace, session.key, session.stage, session.attempt, { maxAttempts: session.maxAttempts, reservationId: session.reservationId }, session.round);
          return;
        }
        if (session.round.deadlineMs !== undefined) {
          session.round.consensus ??= createConsensus(session.round.results);
          if (session.round.consensus.phase !== 'complete') {
            this.launchRoundMember(session.workspace, session.key, session.stage, session.attempt, { maxAttempts: session.maxAttempts, reservationId: session.reservationId }, session.round);
            return;
          }
          if (session.round.revision) {
            const detail = await this.deps.core.getTask(session.key);
            const { diff } = await this.prepareDiff(detail);
            if (diff.headSha !== session.round.revision.headSha || diff.baseSha !== session.round.revision.baseSha) {
              this.console.log(`[reviewer] discarded consensus for changed revision of ${session.key}`);
              await this.deps.core.settleRetry(session.reservationId, { state: 'cancelled', reason: 'revision changed during consensus' });
              return;
            }
          }
          body = consensusReview(session.round.consensus, { key: session.key, fingerprint: session.round.fingerprint, ...session.round.revision });
        } else body = combinedReview(session.round);
      } catch (err) {
        await this.burnAttempt(session.key, session.attempt, session.maxAttempts, `review round failed: ${(err as Error).message}`, session.reservationId);
        return;
      }
    }
    if (session.mode === 'review') {
      // Link the auto-generated change visualization (attached by the viz pass one tick earlier).
      // parseAiReviewComment tolerates trailing text after the fenced JSON; never lose the verdict
      // over a failed lookup.
      try {
        const detail = await this.deps.core.getTask(session.key);
        if (detail.hasVisualization) body += `\n\nVisualization: /api/tasks/${session.key}/visualization`;
      } catch { /* link line is best-effort */ }
    }
    try {
      // A clean doc-stage verdict auto-advances via core's add_comment hook; implementation
      // and findings stay in_review for the human gate; a feedback-eval verdict is advisory on a
      // delivering task (the human clicks "Apply fix"). The reviewer only posts.
      if (session.round) {
        const detail = await this.deps.core.getTask(session.key);
        if (this.stopping || reviewFingerprint(detail) !== session.round.fingerprint) {
          await this.deps.core.settleRetry(session.reservationId, { state: 'cancelled', reason: 'submission changed before publication' });
          return;
        }
        if (this.deps.now() >= (session.round.deadlineMs ?? Infinity)) {
          await this.burnAttempt(session.key, session.attempt, session.maxAttempts, 'consensus total deadline exceeded before publication', session.reservationId);
          return;
        }
      }
      await this.deps.core.addComment(session.key, { actor: 'agent', body });
    } catch (err) {
      // The review succeeded but the post failed — don't burn an attempt; it still needs
      // review, so the next poll retries.
      await this.deps.core.settleRetry(session.reservationId, { state: 'cancelled', reason: 'verdict post failed' });
      this.console.error(`[reviewer] failed to post verdict for ${session.key}: ${(err as Error).message}`);
      return;
    }
    await this.deps.core.settleRetry(session.reservationId, { state: 'succeeded', reason: 'review posted' });
    this.console.log(`[reviewer] posted verdict for ${session.key} (${session.stage}) via ${session.engine}`);
  }

  /** Handle a visualize-session exit: salvage the HTML and attach it, or burn a viz attempt.
   *  Mirrors reapSettled's failure taxonomy, but log-only — no comment, no review budget. */
  private async reapVisualization(session: ReviewSession, code: number | null): Promise<void> {
    const vizKey = session.vizKey ?? session.key;
    const raw = this.readVerdict(session);
    const completedCodexOutput = session.outputFile !== null && raw.trim().length > 0;
    if (session.timedOut && !completedCodexOutput) {
      this.burnVizAttempt(session.key, vizKey, session.attempt, session.maxAttempts, `timed out after ${this.config.reviewMinutes}m`);
      await this.deps.core.settleRetry(session.reservationId, { state: 'failed', reason: 'visualization timed out' });
      return;
    }
    const cliFailure = this.claudeFailure(session, code, raw);
    if (cliFailure) {
      this.burnVizAttempt(session.key, vizKey, session.attempt, session.maxAttempts, cliFailure);
      await this.deps.core.settleRetry(session.reservationId, { state: 'failed', reason: cliFailure });
      return;
    }
    if (!raw.trim()) {
      const reason = code === 0 ? 'engine produced no visualization' : `engine exited code ${code ?? 'null'} with no visualization`;
      this.burnVizAttempt(session.key, vizKey, session.attempt, session.maxAttempts, reason);
      await this.deps.core.settleRetry(session.reservationId, { state: 'failed', reason });
      return;
    }
    const extracted = extractHtml(raw);
    if (extracted === null) {
      this.burnVizAttempt(session.key, vizKey, session.attempt, session.maxAttempts, 'engine did not produce an HTML document');
      await this.deps.core.settleRetry(session.reservationId, { state: 'failed', reason: 'no HTML document' });
      return;
    }
    const html = sanitizeMermaid(extracted);
    if (html.length > MAX_VISUALIZATION_BYTES) {
      this.burnVizAttempt(session.key, vizKey, session.attempt, session.maxAttempts, `visualization exceeds ${MAX_VISUALIZATION_BYTES} bytes`);
      await this.deps.core.settleRetry(session.reservationId, { state: 'failed', reason: 'visualization too large' });
      return;
    }
    try {
      await this.deps.core.attachVisualization(session.key, { html });
    } catch (err) {
      // The page exists but the attach failed — don't burn; visualizationGeneratedAt is still
      // stale, so the next poll retries (same philosophy as a failed verdict post).
      await this.deps.core.settleRetry(session.reservationId, { state: 'cancelled', reason: 'visualization attach failed' });
      this.console.error(`[reviewer] failed to attach visualization for ${session.key}: ${(err as Error).message}`);
      return;
    }
    this.vizAttempts.delete(vizKey);
    await this.deps.core.settleRetry(session.reservationId, { state: 'succeeded', reason: 'visualization attached' });
    this.console.log(`[reviewer] posted visualization for ${session.key} (${html.length} bytes) via ${session.engine}`);
  }

  /** A visualization attempt failed: log-only budget burn, keyed per submission. At the cap the
   *  task simply gets no page until a new submission — never a failure/v1, never the review budget. */
  private burnVizAttempt(key: string, vizKey: string, attempt: number, maxAttempts: number, reason: string): void {
    this.vizAttempts.set(vizKey, attempt);
    this.console.warn(`[reviewer] visualization of ${key} failed (attempt ${attempt}/${maxAttempts}): ${reason}`);
    if (attempt >= maxAttempts) {
      this.console.warn(`[reviewer] giving up on visualization for ${key} until a new submission`);
    }
  }

  /** The verdict text: codex's captured final message (file), or claude's stdout. */
  private readVerdict(session: ReviewSession): string {
    if (session.outputFile) return this.deps.readOutput(session.outputFile);
    return session.stdout;
  }

  /**
   * A review failed (timeout, crash, empty output, or un-preparable): burn an attempt and
   * skip-list at the cap. The reviewer stays advisory (no verdict, no status change), but it
   * posts a `failure/v1` note so the operator sees the auto-review didn't run and the task
   * needs manual review — instead of it silently sitting in_review with no verdict. A later
   * successful review (an ai-review/v1 comment) supersedes the note (see failureByTaskIds).
   */
  private async burnAttempt(key: string, attempt: number, maxAttempts: number, reason: string, reservationId?: string): Promise<void> {
    this.console.warn(`[reviewer] review of ${key} failed (attempt ${attempt}/${maxAttempts}): ${reason}`);
    const atCap = attempt >= maxAttempts;
    try {
      await this.deps.core.addComment(key, {
        actor: 'agent',
        body: buildFailureComment({
          reason: 'review_failed',
          detail: reason,
          source: 'reviewer',
          attempt,
          maxAttempts,
          body: atCap
            ? 'The automated reviewer is skip-listing this task — review it manually.'
            : 'The automated reviewer will retry on the next poll.',
        }),
      });
    } catch (err) {
      this.console.error(`[reviewer] failed to post failure note for ${key}: ${(err as Error).message}`);
    }
    if (reservationId) await this.deps.core.settleRetry(reservationId, { state: 'failed', reason });
    if (atCap) {
      this.skipList(key);
      this.console.warn(
        `[reviewer] ${key} reached maxAttempts (${maxAttempts}); skip-listing — left for a human reviewer`,
      );
    }
  }

  private skipList(key: string): void {
    this.skipped.add(key);
  }
}
