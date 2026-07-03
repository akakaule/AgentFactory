import { z } from 'zod';

/** Permission modes the dispatcher passes through to `claude --permission-mode`. */
export const PERMISSION_MODES = ['acceptEdits', 'bypassPermissions', 'default', 'plan'] as const;
export type PermissionMode = (typeof PERMISSION_MODES)[number];

/**
 * `dispatcher.config.json` schema. Defaults match the design: one session per
 * workspace, a 15 s poll, `acceptEdits` permissions, a 60 min session cap, two attempts.
 */
export const configSchema = z.object({
  /** Path to the agentfactory sqlite DB (read for the queue, written on release/metrics). */
  db: z.string().min(1),
  /** Stable supervisor identity for the health view (one heartbeat row per name). */
  name: z.string().min(1).default('dispatcher'),
  /**
   * Workspace slugs to serve. OMIT to serve every workspace in the DB (opt-out model) —
   * re-read each tick, so a workspace created on the board is picked up with no config edit
   * or restart. When present, pins the dispatcher to exactly these slugs (opt-in back-compat).
   */
  workspaces: z.array(z.string().min(1)).min(1).optional(),
  /** Workspace slugs to never serve — the opt-out list, applied whether or not `workspaces` is set. */
  excludeWorkspaces: z.array(z.string().min(1)).default([]),
  /** Max concurrent sessions per workspace. */
  maxConcurrent: z.number().int().positive().default(1),
  /** Queue poll interval, seconds. */
  pollSeconds: z.number().positive().default(15),
  /** `claude --permission-mode` for unattended sessions. */
  permissionMode: z.enum(PERMISSION_MODES).default('acceptEdits'),
  /** Extra args appended to every `claude` invocation, for every stage. */
  claudeArgs: z.array(z.string()).default([]),
  /**
   * Optional per-stage args, appended AFTER `claudeArgs` for a session serving that
   * stage. Lets you tier the model by pipeline stage (e.g. a fast model for the
   * description/plan write-ups, a strong model for implementation). Because they
   * come last, a per-stage `--model` overrides a global one. Any stage you omit
   * just gets `claudeArgs`.
   */
  stageArgs: z
    .object({
      description: z.array(z.string()).optional(),
      plan: z.array(z.string()).optional(),
      implementation: z.array(z.string()).optional(),
    })
    .strict()
    .optional(),
  /** Hard wall-clock cap per session before the supervisor kills it. */
  maxSessionMinutes: z.number().positive().default(60),
  /** Attempts a task gets before it is skip-listed. */
  maxAttempts: z.number().int().positive().default(2),
  /**
   * DB-scan reaper threshold, minutes. Each tick, an `in_progress` claim NOT owned by a live
   * child (a dispatcher orphan left by a supervisor restart, or an abandoned interactive
   * `/work-task` claim) is released back to `queued` once its staleness — now − (live
   * agent_session heartbeat, else claimed_at) — exceeds this. A still-alive orphaned worker
   * keeps heartbeating via report_progress and is left alone. `0` disables the reaper. Keep it
   * ≥ `maxSessionMinutes` and well above normal report_progress gaps so healthy long-thinking
   * sessions are never yanked.
   */
  staleClaimMinutes: z.number().nonnegative().default(120),
  /**
   * Optional OpenTelemetry export. When set, spawned sessions export token usage as OTLP
   * logs to `endpoint` (e.g. the AgentFactory web server's `/v1/logs`), tagged with the task
   * key — so usage is captured for interactive/streamed runs too. Its presence also disables
   * the dispatcher's stdout metric parse (OTel then owns the tokens, avoiding double-counting).
   */
  otel: z
    .object({
      endpoint: z.string().min(1),
      token: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
});

export type DispatcherConfig = z.infer<typeof configSchema>;

/** Validate a parsed config object, applying defaults. Throws a ZodError on bad input. */
export function parseConfig(raw: unknown): DispatcherConfig {
  return configSchema.parse(raw);
}

/** Load + validate the config file via an injected reader (production passes `fs.readFileSync`). */
export function loadConfig(path: string, readFile: (p: string) => string): DispatcherConfig {
  return parseConfig(JSON.parse(readFile(path)));
}
