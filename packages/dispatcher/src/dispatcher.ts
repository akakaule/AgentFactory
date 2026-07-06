import { buildFailureComment, InvalidTransitionError, resolveServedWorkspaces, gitAuthConfigPairs } from '@agentfactory/core';
import type { AddTaskMetricsInput, Stage, FailureReason, TaskDetail, Task, AgentPromptKey } from '@agentfactory/core';
import type { DispatcherConfig, WorkerEngine } from './config.js';
import type { DispatcherDeps, SpawnedChild, LogWriter, CodexCommand } from './types.js';
import { buildWorkerPrompt, buildMcpConfig, buildSpawnArgs } from './claude.js';
import { buildCodexArgs } from './codex.js';
import { parseCliMetrics, hasMetrics, parsePermissionDenials, type ParsedMetrics } from './metrics.js';

/** Live state for one spawned worker session. */
interface Session {
  label: string;
  workspace: string;
  /** The queued key this session was spawned for (matches the claimed key at maxConcurrent 1). */
  predictedKey: string;
  attempt: number;
  /** Which engine this session runs — claude (`-p`) or codex (`exec`, prompt on stdin). */
  engine: WorkerEngine;
  child: SpawnedChild;
  logWriter: LogWriter;
  startedAtMs: number;
  /** Accumulated stdout — the JSON result envelope is parsed from here for metrics. */
  stdout: string;
  /** Bounded tail of stdout+stderr quoted in the release comment on a crash. */
  logTail: string;
  settled: boolean;
  timedOut: boolean;
  /** Workspace repo path = the session's `claude` cwd, which fixes its transcript dir. */
  cwd: string;
  /** Forced session id (UUID) — the transcript filename, passed via `--session-id`. */
  sessionId: string;
  /** Resolved transcript JSONL path once the file appears; null until then. */
  transcriptPath: string | null;
  /** Bytes of the transcript already tailed into the board. */
  transcriptOffset: number;
  /** The task key the transcript attaches to (the resolved claim); null until claimed. */
  transcriptKey: string | null;
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
  private codexResolved: CodexCommand | null = null;
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
    if (this.config.staleClaimMinutes > 0 && this.config.staleClaimMinutes < this.config.maxSessionMinutes) {
      this.console.warn(
        `[dispatcher] staleClaimMinutes (${this.config.staleClaimMinutes}) < maxSessionMinutes (${this.config.maxSessionMinutes}); ` +
          `the reaper may release a still-alive orphaned worker mid-gap — raise it to at least maxSessionMinutes`,
      );
    }
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
    this.tailTranscripts();
    const served = this.servedWorkspaces();
    this.recordHeartbeat(served);
    this.reapStaleClaims(served);
    for (const workspace of served) this.pollWorkspace(workspace);
  }

  /**
   * The workspace slugs to serve this tick: the explicit `workspaces` allowlist if set, else every
   * workspace in the DB, minus `excludeWorkspaces`. Re-read each tick so a newly-created workspace
   * is dispatched automatically (opt-out model).
   */
  servedWorkspaces(): string[] {
    return resolveServedWorkspaces(
      this.deps.core.listWorkspaces().map((w) => w.name),
      { workspaces: this.config.workspaces, exclude: this.config.excludeWorkspaces },
    );
  }

  /** Report a heartbeat so the board's health view knows this supervisor is alive. Best-effort. */
  private recordHeartbeat(served: string[]): void {
    try {
      this.deps.core.recordSupervisorHeartbeat({
        name: this.config.name,
        kind: 'dispatcher',
        workspaces: served,
        inFlight: this.running.size,
        capacity: this.config.maxConcurrent * served.length,
        pollSeconds: this.config.pollSeconds,
      });
    } catch {
      /* health is advisory — never let a heartbeat write break the poll loop */
    }
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

  // -- stale-claim reaping ---------------------------------------------------

  /**
   * Release `in_progress` claims that have gone silent — a dispatcher orphan left by a restart
   * (this process no longer holds the child, so enforceTimeouts/reap can never see it) or an
   * abandoned interactive `/work-task` claim. Staleness = now − (live agent_session heartbeat,
   * else claimed_at) > staleClaimMinutes. A claim this dispatcher is actively running is skipped
   * (governed by enforceTimeouts, kept warm by touchLiveSessions). Runs each tick before
   * pollWorkspace so a freed task is re-served in the same cycle.
   */
  private reapStaleClaims(served: string[]): void {
    if (this.config.staleClaimMinutes <= 0) return;
    const thresholdMs = this.config.staleClaimMinutes * 60_000;
    const now = this.deps.now();

    // task key -> last live heartbeat. Best-effort: an observability read must never break the tick.
    const heartbeats = new Map<string, string>();
    try {
      for (const a of this.deps.core.listLiveAgents()) heartbeats.set(a.key, a.heartbeatAt);
    } catch (err) {
      this.console.error(`[dispatcher] stale-claim scan skipped: listLiveAgents failed: ${(err as Error).message}`);
      return;
    }

    for (const workspace of served) {
      for (const task of this.deps.core.listTasks({ status: 'in_progress', workspace })) {
        if (task.claimedBy !== null && this.running.has(task.claimedBy)) continue; // our own live child
        if (this.hasRunningFor(task.key)) continue; // a session we just spawned, not yet claimed

        const lastSeen = heartbeats.get(task.key) ?? task.claimedAt;
        if (!lastSeen) continue; // no signal at all — leave it for a human
        const seenMs = Date.parse(lastSeen);
        if (!Number.isFinite(seenMs) || now - seenMs <= thresholdMs) continue;

        // Re-read immediately before releasing: in_review→queued and blocked→queued are BOTH legal
        // human edges, so a raced release against a just-advanced task would SILENTLY succeed and
        // yank it back. Abort unless it is still the same in_progress claim we scanned; the release
        // itself also catches InvalidTransitionError for the residual cross-process window.
        const fresh = this.tryGetTask(task.key);
        if (!fresh || fresh.status !== 'in_progress' || fresh.claimedBy !== task.claimedBy) continue;

        const ageMinutes = Math.round((now - seenMs) / 60_000);
        const label = task.claimedBy ?? 'unknown';
        this.console.log(`[dispatcher] reaping stale claim ${task.key} (claimed by ${label}, no heartbeat for ${ageMinutes}m)`);
        this.releaseClaim(task.key, {
          reason: 'stale',
          detail: `claim by \`${label}\` looks abandoned — no heartbeat for ${ageMinutes}m (staleClaimMinutes ${this.config.staleClaimMinutes})`,
          body:
            'The supervisor found this task `in_progress` with no live agent activity — typically an ' +
            'orphaned claim after a supervisor or session crash. Releasing it back to the queue for pickup.',
          attempt: this.parseAttempt(task.claimedBy),
        });
      }
    }
  }

  /** getTask that swallows a NotFound race (the task vanished under us), returning null. */
  private tryGetTask(key: string): TaskDetail | null {
    try {
      return this.deps.core.getTask(key);
    } catch {
      return null;
    }
  }

  /**
   * Attempt number embedded in a dispatcher worker label (`ws#KEY-aN`), or undefined for a plain
   * (interactive `/work-task`) label. Gates whether a reaped claim carries a retry/skip-list budget.
   */
  private parseAttempt(label: string | null): number | undefined {
    const m = label?.match(/^.+#.+-a(\d+)$/);
    return m ? Number(m[1]) : undefined;
  }

  // -- liveness --------------------------------------------------------------

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

  /**
   * Tail each running session's transcript JSONL into the board so the drawer shows what the
   * agent is actually doing, live. We attach to the *claimed* task (not the predicted one), so
   * we wait until the session has claimed; the small pre-claim portion is caught up from offset 0
   * once we resolve the file. Wholly best-effort — capture must never break the poll loop.
   */
  private tailTranscripts(): void {
    for (const s of this.running.values()) {
      if (s.settled) continue;
      if (s.engine === 'codex') continue; // live transcript tail is the claude JSONL format only
      try {
        if (s.transcriptKey === null) {
          const claimed = this.findClaimed(s);
          if (!claimed) continue; // not claimed yet — attach once we know the task
          s.transcriptKey = claimed.key;
        }
        if (s.transcriptPath === null) {
          s.transcriptPath = this.deps.findTranscript(s.cwd, s.sessionId);
          if (s.transcriptPath === null) continue; // file not written yet
        }
        const slice = this.deps.tailFile(s.transcriptPath, s.transcriptOffset);
        if (slice && slice.chunk) {
          this.deps.core.appendTranscript(s.transcriptKey, { chunk: slice.chunk, attempt: s.attempt, sessionId: s.sessionId });
          s.transcriptOffset = slice.offset;
        }
      } catch {
        /* best-effort — transcript capture is observability, never control flow */
      }
    }
  }

  /** Persist a session's full transcript at exit so it survives worktree prune + ~/.claude GC. */
  private persistTranscript(session: Session, key: string): void {
    if (session.engine === 'codex') return; // codex has no claude JSONL transcript to persist
    try {
      const path = session.transcriptPath ?? this.deps.findTranscript(session.cwd, session.sessionId);
      if (!path) return;
      const raw = this.deps.readFile(path);
      if (raw && raw.trim()) this.deps.core.saveTranscript(key, { raw, attempt: session.attempt, sessionId: session.sessionId });
    } catch {
      /* best-effort */
    }
  }

  // -- spawning --------------------------------------------------------------

  private pollWorkspace(workspace: string): void {
    const queued = this.deps.core.listTasks({ status: 'queued', workspace });
    this.clearRestarted(queued); // an operator restart forgives a task's burned attempts before we decide to skip it
    const slots = this.config.maxConcurrent - this.runningCount(workspace);
    if (slots <= 0) return;
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

  /**
   * Forget the in-memory attempt budget for any queued task an operator has restarted from the
   * board. A restart posts a `restart/v1` marker that supersedes the task's failure note, so the
   * board's derived `failure` goes null — that is our signal to drop the task's skip-list entry and
   * burned-attempt count and retry it with a fresh budget, without bouncing the dispatcher. A task
   * still carrying a failure (mid-retry, or genuinely skip-listed) is left alone, so the maxAttempts
   * guard still holds. (The board-derived `failure` is the single source of truth for "is this
   * stuck"; the dispatcher's maps merely track live retry state and defer to it.)
   */
  private clearRestarted(queued: Task[]): void {
    for (const task of queued) {
      if (task.failure !== null) continue; // still failing / never failed — no stale budget to forgive
      const wasSkipped = this.skipped.delete(task.key);
      const hadAttempts = this.attempts.delete(task.key);
      if (wasSkipped || hadAttempts) {
        this.console.log(`[dispatcher] ${task.key} was restarted from the board; cleared attempt budget, will retry`);
      }
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

  private resolveCodexCommand(): CodexCommand {
    if (this.codexResolved === null) this.codexResolved = this.deps.resolveCodex();
    return this.codexResolved;
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
    const engine: WorkerEngine = this.config.stageEngines?.[stage] ?? this.config.engine ?? 'claude';
    const logPath = `${this.deps.logDir}/${key}-attempt-${attempt}.log`;
    const logWriter = this.deps.openLog(logPath);
    const sessionId = this.deps.uuid();

    const mcpEnv: Record<string, string> = {
      AGENTFACTORY_DB: this.config.db,
      AGENTFACTORY_WORKSPACE: workspace,
      AGENTFACTORY_WORKER: label,
    };
    // The effective worker system prompt for this stage/workspace (override → global → '').
    const systemPrompt = this.deps.core.resolveAgentPrompt(`worker.${stage}` as AgentPromptKey, workspace);

    // Assemble the engine-specific command + argv. Codex reaches the MCP server via `-c` overrides
    // and reads its prompt from stdin; claude uses a written `--mcp-config` file and `-p`.
    let command: string;
    let args: string[];
    let stdin: string | undefined;
    if (engine === 'codex') {
      const codex = this.resolveCodexCommand();
      command = codex.command;
      args = [...codex.args, ...buildCodexArgs({ mcp: this.deps.mcp, mcpEnv, codexArgs: this.config.codexArgs })];
      // codex has no --append-system-prompt; prepend the configured system prompt to the stdin prompt.
      stdin = systemPrompt.trim() ? `${systemPrompt.trim()}\n\n${this.prompt}` : this.prompt;
    } else {
      const mcpConfigPath = `${this.deps.logDir}/${key}-attempt-${attempt}.mcp.json`;
      // The MCP config is a file, not inline: cmd.exe (the Windows .cmd spawn path) strips its quotes.
      this.deps.writeMcp(mcpConfigPath, buildMcpConfig(this.deps.mcp, mcpEnv));
      command = this.resolveCommand();
      args = buildSpawnArgs({
        prompt: this.prompt,
        permissionMode: this.config.permissionMode,
        mcpConfigPath,
        claudeArgs: this.stageClaudeArgs(stage),
        sessionId,
        appendSystemPrompt: systemPrompt,
      });
    }

    const env: NodeJS.ProcessEnv = {
      ...(this.deps.baseEnv ?? {}),
      AGENTFACTORY_WORKSPACE: workspace,
      AGENTFACTORY_WORKER: label,
    };
    if (this.config.otel) {
      // Export token usage over OTLP, tagged with the task key so the receiver attributes it.
      if (engine === 'codex') {
        // codex reads its OTLP config from ~/.codex/config.toml; it only interpolates these in.
        env['AF_TASK_KEY'] = key;
        if (this.config.otel.token) env['AF_OTEL_TOKEN'] = this.config.otel.token;
      } else {
        env['CLAUDE_CODE_ENABLE_TELEMETRY'] = '1';
        env['OTEL_LOGS_EXPORTER'] = 'otlp';
        env['OTEL_EXPORTER_OTLP_PROTOCOL'] = 'http/json';
        env['OTEL_EXPORTER_OTLP_ENDPOINT'] = this.config.otel.endpoint;
        if (this.config.otel.token) env['OTEL_EXPORTER_OTLP_HEADERS'] = `Authorization=Bearer ${this.config.otel.token}`;
        env['OTEL_RESOURCE_ATTRIBUTES'] = `task.key=${key},af.workspace=${workspace},af.worker=${label}`;
      }
    }
    // Git auth for the worker's push/fetch: the board resolves this workspace's PAT (stored, else
    // env) and hands git an http.extraheader (+ a url.insteadOf rewrite that strips any stale
    // credential embedded in the on-disk origin URL) via GIT_CONFIG_* — so the worker authenticates
    // with the managed credential without the secret ever touching the claim payload or `.git/config`.
    // Null (no PAT anywhere) injects nothing — the worker uses ambient git credentials.
    const auth = this.deps.core.resolveGitAuth(workspace);
    if (auth) {
      const pairs = gitAuthConfigPairs(auth);
      const n = Number(env['GIT_CONFIG_COUNT'] ?? '0') || 0;
      env['GIT_CONFIG_COUNT'] = String(n + pairs.length);
      pairs.forEach(([k, v], i) => {
        env[`GIT_CONFIG_KEY_${n + i}`] = k;
        env[`GIT_CONFIG_VALUE_${n + i}`] = v;
      });
    }

    const child = this.deps.spawn({ command, args, cwd, env, stdin });
    const session: Session = {
      label,
      workspace,
      predictedKey: key,
      attempt,
      engine,
      child,
      logWriter,
      startedAtMs: this.deps.now(),
      stdout: '',
      logTail: '',
      settled: false,
      timedOut: false,
      cwd,
      sessionId,
      transcriptPath: null,
      transcriptOffset: 0,
      transcriptKey: null,
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

    // Persist the whole transcript before anything else — covers success, crash, timeout, and the
    // unclaimed-denial path equally, so a stranded/failed task stays reviewable post-mortem.
    this.persistTranscript(session, claimed?.key ?? session.predictedKey);

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

  /** A dead session's claim: build the crash/timeout note and release it through releaseClaim. */
  private releaseAndRetry(session: Session, key: string, code: number | null): void {
    const reasonCode: FailureReason = session.timedOut ? 'timeout' : 'crashed';
    const detail = session.timedOut
      ? `session \`${session.label}\` timed out after ${this.config.maxSessionMinutes}m with the task still in progress`
      : `session \`${session.label}\` exited with code ${code ?? 'null'} with the task still in progress`;
    const tail = this.commentTail(session.logTail);
    this.releaseClaim(key, {
      reason: reasonCode,
      detail,
      body: `Releasing the claim for retry.\n\nLog tail:\n\`\`\`\n${tail}\n\`\`\``,
      attempt: session.attempt,
    });
  }

  /**
   * Release a stranded `in_progress` claim back to `queued` and post the explanatory `failure/v1`
   * note. Shared by the crash/timeout reaper (releaseAndRetry) and the DB-scan reaper
   * (reapStaleClaims). Order matters: release FIRST so a claim that lost a race to a concurrent
   * settle posts no spurious failure note; `in_progress→queued` (human) is the recovery edge, and
   * if it is no longer valid the task already moved on, so we leave it untouched. When `attempt`
   * is supplied (a dispatcher-labelled claim) the retry budget is bookkept and the task is
   * skip-listed at `maxAttempts`; a foreign/interactive claim (no attempt) just returns to the queue.
   */
  private releaseClaim(
    key: string,
    opts: { reason: FailureReason | string; detail: string; body: string; attempt?: number | undefined },
  ): void {
    try {
      this.deps.core.updateStatus(key, 'queued', 'human'); // automate the human claim-recovery release
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.console.log(`[dispatcher] release of ${key} raced a concurrent move; leaving as-is`);
        return;
      }
      this.console.error(`[dispatcher] failed to release ${key}: ${(err as Error).message}`);
      return;
    }

    const attempt = opts.attempt;
    const maxAttempts = attempt !== undefined ? this.config.maxAttempts : undefined;
    try {
      this.deps.core.addComment(key, {
        actor: 'agent',
        body: buildFailureComment({ reason: opts.reason, detail: opts.detail, source: 'dispatcher', attempt, maxAttempts, body: opts.body }),
      });
    } catch {
      /* the release is the contract; the board comment is a bonus */
    }

    if (attempt === undefined) return; // foreign/interactive claim: no attempt budget to bookkeep
    this.attempts.set(key, attempt);
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
