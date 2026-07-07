/**
 * Board-editable supervisor settings. Each supervisor (dispatcher/reviewer/watcher) still boots from
 * its JSON config file (which carries the DB path + secrets), but its TUNABLE knobs can be overridden
 * live from the board: a sparse per-kind settings blob stored in app_kv, merged over the file config
 * each tick (see applySupervisorSettings). No DB settings ⇒ the file config is used unchanged.
 *
 * Excluded on purpose (stay in file/env): `db` (bootstrap), `name` (identity), `otel.token` (secret),
 * and the `github.tokenEnv`/`azdo.patEnv` env-var pointers — so a settings edit can never leak or
 * clobber a credential. Mirrors the agent-prompts app_kv pattern (getGlobalPrompts/setGlobalPrompts).
 */
import { z } from 'zod';
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';
import { parse } from './validate.js';

export const SUPERVISOR_KINDS = ['dispatcher', 'reviewer', 'watcher'] as const;
export type SupervisorKind = (typeof SUPERVISOR_KINDS)[number];

const KV_KEY = 'supervisor_settings';

const wsList = z.array(z.string().min(1)).min(1);
const excludeList = z.array(z.string().min(1));
const stageMap = <T extends z.ZodTypeAny>(v: T) =>
  z.object({ description: v.optional(), plan: v.optional(), implementation: v.optional() }).strict();

// Every field is optional — a settings blob is a SPARSE override over the file config. Field
// constraints mirror the supervisors' own config schemas so a merged value is always valid.
const DISPATCHER_SETTINGS = z
  .object({
    workspaces: wsList.optional(),
    excludeWorkspaces: excludeList.optional(),
    maxConcurrent: z.number().int().positive().optional(),
    pollSeconds: z.number().positive().optional(),
    permissionMode: z.enum(['acceptEdits', 'bypassPermissions', 'default', 'plan']).optional(),
    claudeArgs: z.array(z.string()).optional(),
    stageArgs: stageMap(z.array(z.string())).optional(),
    engine: z.enum(['claude', 'codex']).optional(),
    stageEngines: stageMap(z.enum(['claude', 'codex'])).optional(),
    codexArgs: z.array(z.string()).optional(),
    maxSessionMinutes: z.number().positive().optional(),
    maxAttempts: z.number().int().positive().optional(),
    staleClaimMinutes: z.number().nonnegative().optional(),
    otel: z.object({ endpoint: z.string().min(1) }).strict().optional(),
  })
  .strict();

const REVIEWER_SETTINGS = z
  .object({
    workspaces: wsList.optional(),
    excludeWorkspaces: excludeList.optional(),
    engine: z.enum(['codex', 'claude']).optional(),
    model: z.string().min(1).optional(),
    pollSeconds: z.number().positive().optional(),
    maxConcurrent: z.number().int().positive().optional(),
    reviewMinutes: z.number().positive().optional(),
    maxDiffChars: z.number().nonnegative().optional(),
    maxAttempts: z.number().int().positive().optional(),
    otel: z.object({ endpoint: z.string().min(1) }).strict().optional(),
  })
  .strict();

const WATCHER_SETTINGS = z
  .object({
    workspaces: wsList.optional(),
    excludeWorkspaces: excludeList.optional(),
    pollSeconds: z.number().positive().optional(),
    postMergeChecks: z.boolean().optional(),
    maxBackoffSeconds: z.number().positive().optional(),
    captureBuildErrors: z.boolean().optional(),
    github: z.object({ apiBase: z.string().min(1) }).strict().optional(),
    azdo: z.object({ apiVersion: z.string().min(1) }).strict().optional(),
  })
  .strict();

const SCHEMAS = { dispatcher: DISPATCHER_SETTINGS, reviewer: REVIEWER_SETTINGS, watcher: WATCHER_SETTINGS } as const;

export type DispatcherSettings = z.infer<typeof DISPATCHER_SETTINGS>;
export type ReviewerSettings = z.infer<typeof REVIEWER_SETTINGS>;
export type WatcherSettings = z.infer<typeof WATCHER_SETTINGS>;
export interface SupervisorSettings {
  dispatcher: DispatcherSettings;
  reviewer: ReviewerSettings;
  watcher: WatcherSettings;
}

export function isSupervisorKind(k: string): k is SupervisorKind {
  return (SUPERVISOR_KINDS as readonly string[]).includes(k);
}

function readBlob(db: DB): Record<string, unknown> {
  const raw = getKv(db, KV_KEY);
  if (!raw) return {};
  try {
    const o: unknown = JSON.parse(raw);
    return o && typeof o === 'object' ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** The stored settings for one supervisor kind (sparse), tolerating corruption/unknown keys. */
export function getSupervisorSettings(db: DB, kind: SupervisorKind): Record<string, unknown> {
  const r = SCHEMAS[kind].safeParse(readBlob(db)[kind] ?? {});
  return r.success ? (r.data as Record<string, unknown>) : {};
}

/** All three supervisors' stored settings (for the settings UI). */
export function getAllSupervisorSettings(db: DB): SupervisorSettings {
  return {
    dispatcher: getSupervisorSettings(db, 'dispatcher') as DispatcherSettings,
    reviewer: getSupervisorSettings(db, 'reviewer') as ReviewerSettings,
    watcher: getSupervisorSettings(db, 'watcher') as WatcherSettings,
  };
}

/**
 * Replace one kind's stored settings with a validated (sparse) object. The modal owns the full
 * picture, so PUT is a replace: a field omitted from `input` inherits the file default; `{}` clears
 * all overrides for that kind. Throws ValidationError on a bad value / unknown key.
 */
export function setSupervisorSettings(db: DB, kind: SupervisorKind, input: unknown): Record<string, unknown> {
  const validated = parse(SCHEMAS[kind], input) as Record<string, unknown>;
  const clean: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(validated)) if (v !== undefined) clean[k] = v;
  const blob = readBlob(db);
  blob[kind] = clean;
  setKv(db, KV_KEY, JSON.stringify(blob));
  return clean;
}

/**
 * Merge a sparse settings override over a file config: a set field wins; an absent field keeps the
 * file value; `db`/`name`/secrets (never in settings) always come from the file. Nested objects
 * (otel/github/azdo/stageArgs/stageEngines) are shallow-merged so an excluded secret sub-key (e.g.
 * otel.token, github.tokenEnv) survives; arrays and scalars replace whole.
 */
export function applySupervisorSettings<T extends Record<string, unknown>>(file: T, settings: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...file };
  for (const [k, v] of Object.entries(settings)) {
    if (v === undefined) continue;
    const cur = out[k];
    if (v && typeof v === 'object' && !Array.isArray(v) && cur && typeof cur === 'object' && !Array.isArray(cur)) {
      out[k] = { ...(cur as object), ...(v as object) };
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

/** The effective config for a supervisor: its file config with the DB settings for `kind` merged in. */
export function resolveSupervisorConfig<T extends Record<string, unknown>>(db: DB, kind: SupervisorKind, fileConfig: T): T {
  return applySupervisorSettings(fileConfig, getSupervisorSettings(db, kind));
}
