import { z } from 'zod';
import { boardSchema, repoPathOverridesSchema, xorDbBoard } from '@agentfactory/core';

/**
 * `watcher.config.json` schema. The watcher is a pure REST poller (no LLM, no spawn):
 * it watches every `delivering` task's PR + pipeline and closes or bounces it. Defaults:
 * one poll a minute, pre-merge checks semantics, 15-minute error-backoff cap.
 */
export const baseConfigSchema = z.object({
  /** Path to the agentfactory sqlite DB (read for delivering tasks, written on close/bounce).
   *  XOR with `board`. */
  db: z.string().min(1).optional(),
  /** Remote board (#46): url + SUPERVISOR token (inline or via tokenEnv) — the watcher drives
   *  the delivery ops and reads workspace PATs, both supervisor-gated. XOR with `db`. */
  board: boardSchema.optional(),
  /** workspace name → absolute machine-local clone path (origin resolution runs against it). */
  repoPathOverrides: repoPathOverridesSchema.optional(),
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
   * Check-observation target: false (default) reads PR-head checks (Azure DevOps: PR statuses);
   * true reads merge-commit checks after merge (GitHub check runs/statuses; Azure DevOps commit
   * statuses + builds of the merge commit). A confirmed merge completes the original delivery
   * regardless of this recorded check state; failing merge-commit checks create a backlog follow-up.
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
   * Open the PR once a task is delivering (its implementation review was approved) and no PR exists
   * for the branch — the worker pushes before review but never opens the PR itself (protocol v7).
   * Needs a write-scoped credential (see `github` / `azdo`). When off, or when creation fails,
   * the board's "Open PR" link is the manual way. A workspace's own createPullRequests (Workspaces
   * editor), when set, overrides this for that workspace.
   */
  createPullRequests: z.boolean().default(true),
  /**
   * Merge a delivering task's GitHub PR once its checks pass on exactly the head the human approved
   * on the board — the review already happened there. The merge names that head, so GitHub refuses
   * it if the branch moved. A refusal (branch protection, required reviews) is logged once and the
   * PR is left for a human. Needs Contents: Read and write. Azure DevOps PRs are never merged.
   */
  mergePullRequests: z.boolean().default(true),
  /** How the watcher merges (GitHub's merge_method); the repository must allow it. */
  mergeMethod: z.enum(['merge', 'squash', 'rebase']).default('merge'),
  /**
   * Run each workspace's Azure DevOps work-item import (the workspace `adoSync` settings, edited on
   * the board): claim matching items, import them as `AB#<id>:` tasks, write the board state back.
   * Only workspaces with the import enabled and an Azure DevOps origin are touched; the PAT needs
   * Work Items (Read & write). Set false to switch the import off for every workspace.
   */
  syncWorkItems: z.boolean().default(true),
  /**
   * GitHub REST access. `tokenEnv` names the SHARED token env var (needs Pull requests: Read and
   * write, to open the PR, Contents: Read and write to merge it, plus Checks/Commit statuses read;
   * read-only when createPullRequests and mergePullRequests are off). Per-workspace override: set `<tokenEnv>_<WORKSPACE>` (uppercased, non-alphanumerics →
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
   * Azure DevOps REST access. `patEnv` names the SHARED PAT env var (needs Code (Read & write) to
   * open the PR; Code (Read) when createPullRequests is off; plus Work Items (Read & write) for a
   * workspace with the work-item import enabled). A PAT authenticates to ONE organization, so workspaces in different orgs/projects need
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

/** The base schema plus the db/board XOR. Kept separate because ZodEffects cannot be
 *  `.extend`ed — sibling branches extend `baseConfigSchema` and re-apply `xorDbBoard`. */
export const configSchema = baseConfigSchema.superRefine(xorDbBoard);

export type WatcherConfig = z.infer<typeof baseConfigSchema>;

/** Validate a parsed config object, applying defaults. Throws a ZodError on bad input. */
export function parseConfig(raw: unknown): WatcherConfig {
  return configSchema.parse(raw);
}

/** Load + validate the config file via an injected reader (production passes `fs.readFileSync`). */
export function loadConfig(path: string, readFile: (p: string) => string): WatcherConfig {
  return parseConfig(JSON.parse(readFile(path)));
}
