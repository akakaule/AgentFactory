import { buildFailureComment } from '@agentfactory/core';
import type { Task, TaskDetail, Stage } from '@agentfactory/core';
import type { ReviewerConfig, ReviewEngine } from './config.js';
import type { ReviewerDeps, SpawnedChild, LogWriter } from './types.js';
import { buildEngineArgs } from './engine.js';
import { buildReviewPrompt, ensureMarker } from './review.js';

/** Live state for one spawned review session. */
interface ReviewSession {
  label: string;
  workspace: string;
  key: string;
  stage: Stage;
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
    this.recordHeartbeat();
    for (const workspace of this.config.workspaces) await this.pollWorkspace(workspace);
  }

  /** Report a heartbeat so the board's health view knows the reviewer is alive. Best-effort. */
  private recordHeartbeat(): void {
    try {
      this.deps.core.recordSupervisorHeartbeat({
        name: this.config.name,
        kind: 'reviewer',
        workspaces: this.config.workspaces,
        inFlight: this.running.size,
        capacity: this.config.maxConcurrent * this.config.workspaces.length,
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

  private async pollWorkspace(workspace: string): Promise<void> {
    const slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
    const inReview = this.deps.core.listTasks({ status: 'in_review', workspace });
    let started = 0;
    for (const task of inReview) {
      if (started >= slots) break;
      if (this.skipped.has(task.key)) continue;
      if (this.hasRunningFor(task.key)) continue; // already reviewing this cycle
      if (!this.needsReview(task)) continue; // already has a current verdict
      if (await this.startReview(workspace, task.key)) started += 1;
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
    return link?.label ?? detail.branch ?? null;
  }

  /** Build the prompt + spawn one review; returns false (no slot consumed) on a pre-spawn failure. */
  private async startReview(workspace: string, key: string): Promise<boolean> {
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
      if (detail.stage === 'implementation') {
        const branch = this.resolveBranch(detail);
        if (!branch) throw new Error(`no branch recorded to diff`);
        const diff = await this.deps.computeDiff(detail.repoPath, branch);
        prompt = buildReviewPrompt({ task: detail, engine, branch, diff, maxDiffChars: this.config.maxDiffChars });
      } else {
        prompt = buildReviewPrompt({ task: detail, engine, maxDiffChars: this.config.maxDiffChars });
      }
    } catch (err) {
      // Couldn't prepare the review (no branch, diff failed, task vanished) — burn an attempt.
      this.burnAttempt(key, attempt, `could not prepare review: ${(err as Error).message}`);
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

    this.console.log(`[reviewer] reviewing ${key} (${stage}) via ${engine} — ${label}, log ${logPath}`);
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

    const body = ensureMarker(verdict, session.engine);
    try {
      // A clean doc-stage verdict auto-advances via core's add_comment hook; implementation
      // and findings stay in_review for the human gate. The reviewer only posts.
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
