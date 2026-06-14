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
  /** Workspace slugs to serve. */
  workspaces: z.array(z.string().min(1)).min(1),
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
