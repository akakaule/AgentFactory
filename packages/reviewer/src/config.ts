import { z } from 'zod';

/**
 * The review engines the supervisor can drive. Codex is the default — an independent
 * second opinion on the (typically Claude) dispatcher's work; Claude is also supported.
 */
export const REVIEW_ENGINES = ['codex', 'claude'] as const;
export type ReviewEngine = (typeof REVIEW_ENGINES)[number];

/**
 * `reviewer.config.json` schema. Defaults match the design: Codex engine, a 60 s poll,
 * one review at a time, a 20 min per-review cap, 120k diff chars, two attempts.
 */
export const configSchema = z.object({
  /** Path to the agentfactory sqlite DB (read for in_review tasks, written via add_comment). */
  db: z.string().min(1),
  /** Stable supervisor identity for the health view (one heartbeat row per name). */
  name: z.string().min(1).default('reviewer'),
  /**
   * Workspace slugs to watch. OMIT to watch every workspace in the DB (opt-out model) —
   * re-read each tick, so a workspace created on the board is picked up with no config edit
   * or restart. When present, pins the reviewer to exactly these slugs (opt-in back-compat).
   */
  workspaces: z.array(z.string().min(1)).min(1).optional(),
  /** Workspace slugs to never watch — the opt-out list, applied whether or not `workspaces` is set. */
  excludeWorkspaces: z.array(z.string().min(1)).default([]),
  /** Which CLI runs the review. */
  engine: z.enum(REVIEW_ENGINES).default('codex'),
  /** Optional model override passed to the engine (codex `-m`, claude `--model`). */
  model: z.string().min(1).optional(),
  /** Queue poll interval, seconds. */
  pollSeconds: z.number().positive().default(60),
  /** Max concurrent review sessions per workspace. */
  maxConcurrent: z.number().int().positive().default(1),
  /** Hard wall-clock cap per review before the supervisor kills it. */
  reviewMinutes: z.number().positive().default(20),
  /** The diff is truncated to this many chars before going into the prompt (0 = no limit). */
  maxDiffChars: z.number().int().nonnegative().default(120000),
  /** Attempts a task gets before it is skip-listed (left for a human). */
  maxAttempts: z.number().int().positive().default(2),
  /**
   * Optional OpenTelemetry export. When set, each spawned review binds its token usage to the
   * task so usage lands attributed (not "unattributed") in the live Telemetry feed + per-task
   * rollup. Wiring is per engine: the `claude` engine gets the OTLP env vars + a `task.key`
   * resource attribute (like the dispatcher); the `codex` engine reads its OTLP config from
   * `~/.codex/config.toml` and only needs `AF_TASK_KEY` (and `AF_OTEL_TOKEN`) in the env, which
   * that file interpolates into its `X-Task-Key` (and `Authorization`) headers.
   */
  otel: z
    .object({
      endpoint: z.string().min(1),
      token: z.string().min(1).optional(),
    })
    .strict()
    .optional(),
});

export type ReviewerConfig = z.infer<typeof configSchema>;

/** Validate a parsed config object, applying defaults. Throws a ZodError on bad input. */
export function parseConfig(raw: unknown): ReviewerConfig {
  return configSchema.parse(raw);
}

/** Load + validate the config file via an injected reader (production passes `fs.readFileSync`). */
export function loadConfig(path: string, readFile: (p: string) => string): ReviewerConfig {
  return parseConfig(JSON.parse(readFile(path)));
}
