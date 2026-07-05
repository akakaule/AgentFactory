import { z } from 'zod';

/**
 * `watcher.config.json` schema. The watcher is a pure REST poller (no LLM, no spawn):
 * it watches every `delivering` task's PR + pipeline and closes or bounces it. Defaults:
 * one poll a minute, pre-merge checks semantics, 15-minute error-backoff cap.
 */
export const configSchema = z.object({
  /** Path to the agentfactory sqlite DB (read for delivering tasks, written on close/bounce). */
  db: z.string().min(1),
  /** Stable supervisor identity for the health view (one heartbeat row per name). */
  name: z.string().min(1).default('watcher'),
  /**
   * Workspace slugs to serve. OMIT to serve every workspace in the DB (opt-out model) —
   * re-read each tick, so a workspace created on the board is picked up with no config edit
   * or restart. When present, pins the watcher to exactly these slugs (opt-in back-compat).
   */
  workspaces: z.array(z.string().min(1)).min(1).optional(),
  /** Workspace slugs to never serve — the opt-out list, applied whether or not `workspaces` is set. */
  excludeWorkspaces: z.array(z.string().min(1)).default([]),
  /** Poll interval, seconds. */
  pollSeconds: z.number().positive().default(60),
  /**
   * Pipeline-green semantics. false (default): a merged PR whose head checks did not conclude
   * red completes the delivery — pre-merge checks are the near-universal gate (branch
   * protection / ADO build validation), and repos without checks flow through ('none' counts
   * as green). true: additionally wait for the check runs on the MERGE COMMIT to finish green
   * after the merge (a red post-merge run bounces the task like any CI failure).
   */
  postMergeChecks: z.boolean().default(false),
  /** Cap for the per-task exponential error backoff, seconds. */
  maxBackoffSeconds: z.number().positive().default(900),
  /**
   * On a failing PR build, fetch the actual build errors (ADO build-timeline issues / GitHub
   * check-run output) and embed them in the requeue note, so the fixing worker gets the concrete
   * error, not just check names. Best-effort — a fetch failure degrades to names-only. One extra
   * REST call per bounce; ADO needs the PAT to also have Build (Read). Set false to disable.
   */
  captureBuildErrors: z.boolean().default(true),
  /**
   * GitHub REST access. `tokenEnv` names the SHARED token env var (needs repo read scope: PRs +
   * checks). Per-workspace override: set `<tokenEnv>_<WORKSPACE>` (uppercased, non-alphanumerics →
   * `_`) to give one workspace its own token — e.g. `GITHUB_TOKEN_ACME`. Falls back to the shared var.
   */
  github: z
    .object({
      tokenEnv: z.string().min(1).default('GITHUB_TOKEN'),
      apiBase: z.string().min(1).default('https://api.github.com'),
    })
    .strict()
    .default({}),
  /**
   * Azure DevOps REST access. `patEnv` names the SHARED PAT env var (needs Code (Read) scope — never
   * write). A PAT authenticates to ONE organization, so workspaces in different orgs/projects need
   * their own: set `<patEnv>_<WORKSPACE>` (e.g. `AZDO_PAT_KL_DISCONFIGURATION`) to override per
   * workspace; falls back to the shared `patEnv`.
   */
  azdo: z
    .object({
      patEnv: z.string().min(1).default('AZDO_PAT'),
      apiVersion: z.string().min(1).default('7.1'),
    })
    .strict()
    .default({}),
});

export type WatcherConfig = z.infer<typeof configSchema>;

/** Validate a parsed config object, applying defaults. Throws a ZodError on bad input. */
export function parseConfig(raw: unknown): WatcherConfig {
  return configSchema.parse(raw);
}

/** Load + validate the config file via an injected reader (production passes `fs.readFileSync`). */
export function loadConfig(path: string, readFile: (p: string) => string): WatcherConfig {
  return parseConfig(JSON.parse(readFile(path)));
}
