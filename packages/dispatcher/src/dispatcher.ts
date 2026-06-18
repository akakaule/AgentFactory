import { buildFailureComment } from '@agentfactory/core';
import type { AddTaskMetricsInput, Stage } from '@agentfactory/core';
import type { DispatcherConfig } from './config.js';
import type { DispatcherDeps, SpawnedChild, LogWriter } from './types.js';
import { buildWorkerPrompt, buildMcpConfig, buildSpawnArgs } from './claude.js';
import { parseCliMetrics, hasMetrics, parsePermissionDenials, type ParsedMetrics } from './metrics.js';

/** Live state for one spawned worker session. */
interface Session {
  label: string;
  workspace: string;
  /** The queued key this session was spawned for (matches the claimed key at maxConcurrent 1). */
  predictedKey: string;
  attempt: number;
  child: SpawnedChild;
  logWriter: LogWriter;
  startedAtMs: number;
  /** Accumulated stdout — the JSON result envelope is parsed from here for metrics. */
  stdout: string;
  /** Bounded tail of stdout+stderr quoted in the release comment on a crash. */
  logTail: string;
  settled: boolean;
  timedOut: boolean;
}

const LOG_TAIL_CHARS = 4000;
const COMMENT_TAIL_LINES = 40;

/**
 * The supervisor. Polls the queue read-only and spawns one fresh headless `claude`
 * session per task (the session claims — the dispatcher never does), reaps each exit
 * to record measured metrics, and releases + retries the claim of any session that
 * dies mid-task. All side effects (spawn, clock, logs, console) are injected via deps.
 */
export class Dispatcher {
  private readonly running = new Map<string, Session>(); // label -> session
  private readonly attempts = new Map<string, number>(); // task key -> attempts used
  private readonly skipped = new Set<string>(); // task keys past maxAttempts
  private readonly prompt = buildWorkerPrompt();
  private claudeCommand: string | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly config: DispatcherConfig,
    private readonly deps: DispatcherDeps,
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

  /** Stop polling and kill any in-flight sessions. */
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
      this.console.error(`[dispatcher] tick failed: ${(err as Error).message}`);
    }
  }

  /** One poll cycle: enforce session timeouts, then spawn for each workspace's free slots. */
  async tick(): Promise<void> {
    this.enforceTimeouts();
    this.touchLiveSessions();
    for (const workspace of this.config.workspaces) this.pollWorkspace(workspace);
  }

  /** Number of live sessions currently serving a workspace. */
  runningCount(workspace?: string): number {
    if (workspace === undefined) return this.running.size;
    let n = 0;
    for (const s of this.running.values()) if (s.workspace === workspace) n += 1;
    return n;
  }

  /** True once a task has burned its attempts and is no longer served. */
  isSkipListed(key: string): boolean {
    return this.skipped.has(key);
  }

  // -- timeouts --------------------------------------------------------------

  private enforceTimeouts(): void {
    const capMs = this.config.maxSessionMinutes * 60_000;
    const now = this.deps.now();
    for (const session of this.running.values()) {
      if (session.timedOut || session.settled) continue;
      if (now - session.startedAtMs > capMs) {
        session.timedOut = true;
        this.appendLog(session, `\n[dispatcher] session exceeded maxSessionMinutes (${this.config.maxSessionMinutes}m); killing\n`);
        try {
          session.child.kill('SIGKILL');
        } catch {
          /* the exit handler still runs the crash path */
        }
      }
    }
  }

  /** Keep each running session's live row warm between agent milestones (best-effort liveness). */
  private touchLiveSessions(): void {
    for (const s of this.running.values()) {
      if (s.settled) continue;
      try {
        this.deps.core.touchAgentSession(s.predictedKey);
      } catch {
        /* best-effort — a missing live row (not yet claimed / already ended) is fine */
      }
    }
  }

  // -- spawning --------------------------------------------------------------

  private pollWorkspace(workspace: string): void {
    const slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
    const queued = this.deps.core.listTasks({ status: 'queued', workspace });
    let spawned = 0;
    for (const task of queued) {
      if (spawned >= slots) break;
      if (this.skipped.has(task.key)) continue;
      if (this.hasRunningFor(task.key)) continue; // already spawned this cycle / not yet claimed
      const attempt = (this.attempts.get(task.key) ?? 0) + 1;
      if (attempt > this.config.maxAttempts) {
        this.skipList(task.key);
        continue;
      }
      if (this.spawnSession(workspace, task.key, task.stage, attempt)) spawned += 1;
    }
  }

  private hasRunningFor(key: string): boolean {
    for (const s of this.running.values()) if (s.predictedKey === key) return true;
    return false;
  }

  private repoPath(workspace: string): string | undefined {
    return this.deps.core.listWorkspaces().find((w) => w.name === workspace)?.repoPath;
  }

  private resolveCommand(): string {
    if (this.claudeCommand === null) this.claudeCommand = this.deps.resolveClaude();
    return this.claudeCommand;
  }

  /** Global claudeArgs plus any per-stage args (stage args last, so a stage `--model` wins). */
  private stageClaudeArgs(stage: Stage): string[] {
    return [...this.config.claudeArgs, ...(this.config.stageArgs?.[stage] ?? [])];
  }

  /** Spawn one session; returns false (no slot consumed) if the workspace can't be launched. */
  private spawnSession(workspace: string, key: string, stage: Stage, attempt: number): boolean {
    const cwd = this.repoPath(workspace);
    if (!cwd) {
      this.console.warn(`[dispatcher] workspace '${workspace}' has no repoPath; cannot spawn for ${key}`);
      return false;
    }
    const label = `${workspace}#${key}-a${attempt}`;
    const logPath = `${this.deps.logDir}/${key}-attempt-${attempt}.log`;
    const mcpConfigPath = `${this.deps.logDir}/${key}-attempt-${attempt}.mcp.json`;
    const logWriter = this.deps.openLog(logPath);

    const mcpEnv: Record<string, string> = {
      AGENTFACTORY_DB: this.config.db,
      AGENTFACTORY_WORKSPACE: workspace,
      AGENTFACTORY_WORKER: label,
    };
    // The MCP config is written to a file rather than inlined: cmd.exe (the Windows .cmd
    // spawn path) strips the JSON's embedded quotes from argv.
    this.deps.writeMcp(mcpConfigPath, buildMcpConfig(this.deps.mcp, mcpEnv));
    const args = buildSpawnArgs({
      prompt: this.prompt,
      permissionMode: this.config.permissionMode,
      mcpConfigPath,
      claudeArgs: this.stageClaudeArgs(stage),
    });
    const env: NodeJS.ProcessEnv = {
      ...(this.deps.baseEnv ?? {}),
      AGENTFACTORY_WORKSPACE: workspace,
      AGENTFACTORY_WORKER: label,
    };
    if (this.config.otel) {
      // Export token usage over OTLP (captured even for streamed/interactive turns), tagged
      // with the task key so the receiver attributes it to this task.
      env['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1';
      env['OTEL_LOGS_EXPORTER'] = 'otlp';
      env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json';
      env['OTEL_EXPORTER_OTLP_ENDPOINT'] = this.config.otel.endpoint;
      if (this.config.otel.token) env['OTEL_EXPORTER_OTLP_HEADERS'] = `Authorization=Bearer ${this.config.otel.token}`;
      env['OTEL_RESOURCE_ATTRIBUTES'] = `task.key=${key},af.workspace=${workspace},af.worker=${label}`;
    }

    const child = this.deps.spawn({ command: this.resolveCommand(), args, cwd, env });
    const session: Session = {
      label,
      workspace,
      predictedKey: key,
      attempt,
      child,
      logWriter,
      startedAtMs: this.deps.now(),
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
      this.appendLog(session, `\n[dispatcher] spawn error: ${err.message}\n`);
      this.reap(session, null);
    });
    child.on('exit', (code) => this.reap(session, code));

    this.console.log(`[dispatcher] spawned ${label} (cwd ${cwd}, log ${logPath})`);
    return true;
  }

  private appendLog(session: Session, text: string): void {
    session.logWriter.write(text);
    session.logTail = (session.logTail + text).slice(-LOG_TAIL_CHARS);
  }

  // -- reaping ---------------------------------------------------------------

  /** Handle a session exit: record metrics, then either confirm success or release + retry. */
  private reap(session: Session, code: number | null): void {
    if (session.settled) return;
    session.settled = true;
    this.running.delete(session.label);
    session.logWriter.end();

    const claimed = this.findClaimed(session);
    const metrics = parseCliMetrics(session.stdout);

    if (!claimed) {
      // The session never claimed: empty queue, a lost race, a permission denial,
      // or a crash before claim. A denial is a misconfiguration — respawning would
      // burn a session per poll forever, so it consumes an attempt like a crash.
      const denials = parsePermissionDenials(session.stdout);
      if (denials.length > 0) {
        this.recordDenial(session, denials);
      } else if (code !== 0) {
        this.console.warn(`[dispatcher] ${session.label} exited (code ${code ?? 'null'}) without claiming a task`);
      } else {
        this.console.log(`[dispatcher] ${session.label} claimed nothing (queue empty or lost race); exiting clean`);
      }
      return;
    }

    // OTel (when configured) owns token capture — skip the stdout parse to avoid double-counting.
    if (!this.config.otel && hasMetrics(metrics)) this.recordMetrics(claimed.key, session.label, metrics);

    // the process exited: end its live session. submit_result already ended it on success;
    // this also clears a crashed in_progress session the agent never got to end before dying.
    try {
      this.deps.core.endAgentSession(claimed.key);
    } catch {
      /* best-effort */
    }

    if (claimed.status === 'in_progress') {
      this.releaseAndRetry(session, claimed.key, code);
    } else {
      const note = code === 0 ? '' : ` (exited code ${code ?? 'null'} after advancing)`;
      this.console.log(`[dispatcher] ${session.label} finished ${claimed.key} -> ${claimed.status}${note}`);
    }
  }

  /** The task this session claimed — matched on the worker label persisted as claimed_by. */
  private findClaimed(session: Session): { key: string; status: string } | undefined {
    const all = this.deps.core.listTasks({ workspace: session.workspace });
    const row = all.find((t) => t.claimedBy === session.label);
    return row ? { key: row.key, status: row.status } : undefined;
  }

  private recordMetrics(key: string, label: string, m: ParsedMetrics): void {
    const input: AddTaskMetricsInput = { reportedBy: label };
    if (m.model !== undefined) input.model = m.model;
    if (m.tokensIn !== undefined) input.tokensIn = m.tokensIn;
    if (m.tokensOut !== undefined) input.tokensOut = m.tokensOut;
    if (m.costUsd !== undefined) input.costUsd = m.costUsd;
    try {
      this.deps.core.addTaskMetrics(key, input);
    } catch (err) {
      this.console.warn(`[dispatcher] failed to record metrics for ${key}: ${(err as Error).message}`);
    }
  }

  /** An unclaimed session was permission-denied: warn, surface it on the task, burn an attempt. */
  private recordDenial(session: Session, denials: string[]): void {
    const key = session.predictedKey;
    const attempt = session.attempt;
    this.attempts.set(key, attempt);
    this.console.warn(
      `[dispatcher] ${session.label} exited without claiming — permission denied for ${denials.join(', ')}; ` +
        `check --allowedTools / permission settings`,
    );
    try {
      this.deps.core.addComment(key, {
        actor: 'agent',
        body: buildFailureComment({
          reason: 'permission_denied',
          detail: `permission denied for ${denials.join(', ')}`,
          source: 'dispatcher',
          attempt,
          maxAttempts: this.config.maxAttempts,
          body:
            `Session \`${session.label}\` was permission denied for ${denials.map((d) => `\`${d}\``).join(', ')} ` +
            `and exited without claiming. The worker's tool allowlist or permission mode is misconfigured.`,
        }),
      });
    } catch {
      /* the console warning is the contract; the board comment is a bonus */
    }
    if (attempt >= this.config.maxAttempts) {
      this.skipList(key);
      this.console.warn(
        `[dispatcher] ${key} reached maxAttempts (${this.config.maxAttempts}); skip-listing — left queued for a human`,
      );
    }
  }

  private releaseAndRetry(session: Session, key: string, code: number | null): void {
    const attempt = session.attempt;
    this.attempts.set(key, attempt);

    const reasonCode = session.timedOut ? 'timeout' : 'crashed';
    const detail = session.timedOut
      ? `session \`${session.label}\` timed out after ${this.config.maxSessionMinutes}m`
      : `session \`${session.label}\` exited with code ${code ?? 'null'}`;
    const tail = this.commentTail(session.logTail);
    const body = buildFailureComment({
      reason: reasonCode,
      detail: `${detail} with the task still in progress`,
      source: 'dispatcher',
      attempt,
      maxAttempts: this.config.maxAttempts,
      body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail}\n\`\`\``,
    });

    try {
      this.deps.core.addComment(key, { actor: 'agent', body });
      this.deps.core.updateStatus(key, 'queued', 'human'); // automate the human claim-recovery release
    } catch (err) {
      this.console.error(`[dispatcher] failed to release ${key}: ${(err as Error).message}`);
      return;
    }

    if (attempt >= this.config.maxAttempts) {
      this.skipList(key);
      this.console.warn(
        `[dispatcher] ${key} reached maxAttempts (${this.config.maxAttempts}); skip-listing — left queued for a human`,
      );
      try {
        this.deps.core.addComment(key, {
          actor: 'agent',
          body: buildFailureComment({
            reason: 'max_attempts',
            detail: `reached maxAttempts (${this.config.maxAttempts}) and is skip-listed`,
            source: 'dispatcher',
            attempt,
            maxAttempts: this.config.maxAttempts,
            body: 'No further sessions will be spawned until a human intervenes.',
          }),
        });
      } catch {
        /* the console warning is the contract; the board comment is a bonus */
      }
    } else {
      this.console.log(`[dispatcher] released ${key} after attempt ${attempt}; will retry`);
    }
  }

  private commentTail(buf: string): string {
    const lines = buf.split(/\r?\n/);
    return lines.slice(-COMMENT_TAIL_LINES).join('\n').trim();
  }

  private skipList(key: string): void {
    this.skipped.add(key);
  }
}
