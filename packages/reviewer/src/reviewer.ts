import { buildFailureComment, refFromLabel, resolveServedWorkspaces, isPrFeedbackMarker, isFeedbackEvalMarker, parsePrFeedbackComment } from '@agentfactory/core';
import type { Task, TaskDetail, Stage } from '@agentfactory/core';
import type { ReviewerConfig, ReviewEngine } from './config.js';
import type { ReviewerDeps, SpawnedChild, LogWriter } from './types.js';
import { buildEngineArgs } from './engine.js';
import { buildReviewPrompt, ensureMarker, buildFeedbackEvalPrompt, ensureFeedbackEvalMarker } from './review.js';

/** A review session evaluates one of two things: a task's deliverable (`review` → ai-review/v1) or
 *  a forwarded PR-review comment on a delivering task (`feedback-eval` → feedback-eval/v1). */
type ReviewMode = 'review' | 'feedback-eval';

/** Live state for one spawned review session. */
interface ReviewSession {
  label: string;
  workspace: string;
  key: string;
  stage: Stage;
  mode: ReviewMode;
  attempt: number;
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
}

const LOG_TAIL_CHARS = 4000;

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
  private readonly attempts = new Map<string, number>(); // task key -> attempts used
  private readonly skipped = new Set<string>(); // task keys past maxAttempts
  private readonly engineCommands = new Map<ReviewEngine, string>(); // cached resolutions
  private timer: ReturnType<typeof setInterval> | null = null;

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
    void this.safeTick();
    this.timer = setInterval(() => void this.safeTick(), this.config.pollSeconds * 1000);
  }

  /** Stop polling and kill any in-flight reviews. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const session of this.running.values()) {
      try {
        session.child.kill('SIGTERM');
      } catch {
        /* best-effort */
      }
    }
  }

  private async safeTick(): Promise<void> {
    try {
      await this.tick();
    } catch (err) {
      this.console.error(`[reviewer] tick failed: ${(err as Error).message}`);
    }
  }

  /** One poll cycle: enforce review timeouts, then start reviews for each workspace's free slots. */
  async tick(): Promise<void> {
    this.enforceTimeouts();
    const served = this.servedWorkspaces();
    this.recordHeartbeat(served);
    for (const workspace of served) await this.pollWorkspace(workspace);
  }

  /**
   * The workspace slugs to watch this tick: the explicit `workspaces` allowlist if set, else every
   * workspace in the DB, minus `excludeWorkspaces`. Re-read each tick so a newly-created workspace
   * is reviewed automatically (opt-out model).
   */
  servedWorkspaces(): string[] {
    return resolveServedWorkspaces(
      this.deps.core.listWorkspaces().map((w) => w.name),
      { workspaces: this.config.workspaces, exclude: this.config.excludeWorkspaces },
    );
  }

  /** Report a heartbeat so the board's health view knows the reviewer is alive. Best-effort. */
  private recordHeartbeat(served: string[]): void {
    try {
      this.deps.core.recordSupervisorHeartbeat({
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

  private enforceTimeouts(): void {
    const capMs = this.config.reviewMinutes * 60_000;
    const now = this.deps.now();
    for (const session of this.running.values()) {
      if (session.timedOut || session.settled) continue;
      if (now - session.startedAtMs > capMs) {
        session.timedOut = true;
        this.appendLog(session, `\n[reviewer] review exceeded reviewMinutes (${this.config.reviewMinutes}m); killing\n`);
        try {
          session.child.kill('SIGKILL');
        } catch {
          /* the exit handler still runs the failure path */
        }
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

  private async pollWorkspace(workspace: string): Promise<void> {
    let slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
    const inReview = this.deps.core.listTasks({ status: 'in_review', workspace });
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
    for (const task of this.deps.core.listTasks({ status: 'delivering', workspace })) {
      if (slots <= 0) break;
      if (this.skipped.has(task.key)) continue;
      if (this.hasRunningFor(task.key)) continue;
      if (!this.needsEval(this.deps.core.getTask(task.key))) continue;
      if (await this.startReview(workspace, task.key, 'feedback-eval')) slots -= 1;
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
   * `af.workspace`/`af.worker` resource attribute); `codex` reads OTLP from `~/.codex/config.toml`
   * and only interpolates `AF_TASK_KEY`/`AF_OTEL_TOKEN` from the env into its header values.
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

  /** Branch to diff: the last branch-kind link (as the board's diff view uses), else the named branch. */
  private resolveBranch(detail: TaskDetail): string | null {
    const link = detail.links.filter((l) => l.kind === 'branch').at(-1);
    // The label may be decorated (e.g. "feature/x (PR 4703 source — …)"); recover the bare
    // ref so the annotation never reaches git. Keep the raw label as the fallback so a truly
    // unparseable label still fails loudly in branchDiff, exactly as before.
    if (link) return refFromLabel(link.label) ?? link.label;
    return detail.branch ?? null;
  }

  /** Build the prompt + spawn one review/evaluation; returns false (no slot consumed) on a pre-spawn failure. */
  private async startReview(workspace: string, key: string, mode: ReviewMode = 'review'): Promise<boolean> {
    const attempt = (this.attempts.get(key) ?? 0) + 1;
    if (attempt > this.config.maxAttempts) {
      this.skipList(key);
      return false;
    }

    const engine = this.config.engine;
    let prompt: string;
    let stage: Stage;
    try {
      const detail = this.deps.core.getTask(key);
      stage = detail.stage;
      if (mode === 'feedback-eval') {
        // critically evaluate the latest forwarded PR-review comment against the branch diff
        const systemPrompt = this.deps.core.resolveAgentPrompt('delivering-evaluator', detail.workspace);
        const branch = this.resolveBranch(detail);
        if (!branch) throw new Error('no branch recorded to diff');
        const feedback = [...detail.activity.filter((a) => a.type === 'comment')].reverse()
          .map((a) => parsePrFeedbackComment(a.body)).find((p) => p !== null);
        if (!feedback) throw new Error('no pr-feedback to evaluate');
        const diff = await this.deps.computeDiff(detail.repoPath, branch);
        prompt = buildFeedbackEvalPrompt({ task: detail, engine, feedback: feedback.feedback, branch, diff, maxDiffChars: this.config.maxDiffChars, systemPrompt });
      } else {
        // the configured reviewer system prompt (workspace override → global default → ''), inlined
        const systemPrompt = this.deps.core.resolveAgentPrompt('reviewer', detail.workspace);
        if (detail.stage === 'implementation') {
          const branch = this.resolveBranch(detail);
          if (!branch) throw new Error(`no branch recorded to diff`);
          // A pr-review task's branch link is a teammate's PR head, not in the local store: fetch it
          // into origin/<head> and diff that. resolveBaseRef already yields origin/<default>, so the
          // diff is origin/<base>...origin/<head> (default-base PRs; the producer skips others).
          let diffRef = branch;
          if (detail.kind === 'pr-review') {
            await this.deps.fetchRef(detail.repoPath, branch);
            diffRef = `origin/${branch}`;
          }
          const diff = await this.deps.computeDiff(detail.repoPath, diffRef);
          prompt = buildReviewPrompt({ task: detail, engine, branch: diffRef, diff, maxDiffChars: this.config.maxDiffChars, systemPrompt });
        } else {
          prompt = buildReviewPrompt({ task: detail, engine, maxDiffChars: this.config.maxDiffChars, systemPrompt });
        }
      }
    } catch (err) {
      // Couldn't prepare the review (no branch, diff failed, task vanished) — burn an attempt.
      this.burnAttempt(key, attempt, `could not prepare ${mode}: ${(err as Error).message}`);
      return false;
    }

    const label = `${workspace}#${key}-r${attempt}`;
    const logPath = `${this.deps.logDir}/${key}-review-${attempt}.log`;
    const outputFile = engine === 'codex' ? `${this.deps.logDir}/${key}-review-${attempt}.out` : null;
    const logWriter = this.deps.openLog(logPath);
    const args = buildEngineArgs({ engine, model: this.config.model, outputFile: outputFile ?? '' });
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
      engine,
      child,
      logWriter,
      startedAtMs: this.deps.now(),
      outputFile,
      stdout: '',
      logTail: '',
      settled: false,
      timedOut: false,
    };
    this.running.set(label, session);

    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString();
      session.stdout += text;
      this.appendLog(session, text);
    });
    child.stderr?.on('data', (chunk) => this.appendLog(session, chunk.toString()));
    child.on('error', (err) => {
      this.appendLog(session, `\n[reviewer] spawn error: ${err.message}\n`);
      this.reap(session, null);
    });
    child.on('exit', (code) => this.reap(session, code));

    this.console.log(`[reviewer] ${mode === 'feedback-eval' ? 'evaluating feedback on' : 'reviewing'} ${key} (${stage}) via ${engine} — ${label}, log ${logPath}`);
    return true;
  }

  private appendLog(session: ReviewSession, text: string): void {
    session.logWriter.write(text);
    session.logTail = (session.logTail + text).slice(-LOG_TAIL_CHARS);
  }

  // -- reaping ---------------------------------------------------------------

  /** Handle a review exit: read the verdict and post it, or burn an attempt on failure. */
  private reap(session: ReviewSession, code: number | null): void {
    if (session.settled) return;
    session.settled = true;
    this.running.delete(session.label);
    session.logWriter.end();

    if (session.timedOut) {
      this.burnAttempt(session.key, session.attempt, `timed out after ${this.config.reviewMinutes}m`);
      return;
    }

    const verdict = this.readVerdict(session);
    if (!verdict.trim()) {
      const reason = code === 0 ? 'engine produced no verdict' : `engine exited code ${code ?? 'null'} with no verdict`;
      this.burnAttempt(session.key, session.attempt, reason);
      return;
    }

    const body = session.mode === 'feedback-eval' ? ensureFeedbackEvalMarker(verdict) : ensureMarker(verdict, session.engine);
    try {
      // A clean doc-stage verdict auto-advances via core's add_comment hook; implementation
      // and findings stay in_review for the human gate; a feedback-eval verdict is advisory on a
      // delivering task (the human clicks "Apply fix"). The reviewer only posts.
      this.deps.core.addComment(session.key, { actor: 'agent', body });
    } catch (err) {
      // The review succeeded but the post failed — don't burn an attempt; it still needs
      // review, so the next poll retries.
      this.console.error(`[reviewer] failed to post verdict for ${session.key}: ${(err as Error).message}`);
      return;
    }
    this.attempts.delete(session.key); // reviewed successfully — reset the attempt budget
    this.console.log(`[reviewer] posted verdict for ${session.key} (${session.stage}) via ${session.engine}`);
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
  private burnAttempt(key: string, attempt: number, reason: string): void {
    this.attempts.set(key, attempt);
    this.console.warn(`[reviewer] review of ${key} failed (attempt ${attempt}/${this.config.maxAttempts}): ${reason}`);
    const atCap = attempt >= this.config.maxAttempts;
    try {
      this.deps.core.addComment(key, {
        actor: 'agent',
        body: buildFailureComment({
          reason: 'review_failed',
          detail: reason,
          source: 'reviewer',
          attempt,
          maxAttempts: this.config.maxAttempts,
          body: atCap
            ? 'The automated reviewer is skip-listing this task — review it manually.'
            : 'The automated reviewer will retry on the next poll.',
        }),
      });
    } catch (err) {
      this.console.error(`[reviewer] failed to post failure note for ${key}: ${(err as Error).message}`);
    }
    if (atCap) {
      this.skipList(key);
      this.console.warn(
        `[reviewer] ${key} reached maxAttempts (${this.config.maxAttempts}); skip-listing — left for a human reviewer`,
      );
    }
  }

  private skipList(key: string): void {
    this.skipped.add(key);
  }
}
