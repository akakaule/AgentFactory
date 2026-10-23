/**
 * Board-editable agent model settings (app_kv, JSON): which engine, model and reasoning effort
 * each agent role runs with, globally and per workspace. Supervisors read the document every tick
 * and resolve each role with the precedence workspace override → board global → the supervisor's
 * config file → the CLI's own default, so a change applies to the next session with no config
 * edit or restart. An empty document changes nothing. Corrupt or no-longer-valid stored state
 * reads as empty, the same rule `engine_settings` uses.
 *
 * Profiles are typed fields, never raw CLI args: supervisors turn them into the engine's own flags
 * (`modelProfileArgs`), and model ids are restricted to characters cmd.exe does not interpret (a
 * Claude model id can ride through the Windows `.cmd` shim).
 */
import { z } from 'zod';
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';
import { listWorkspaces } from './ops/listWorkspaces.js';
import { AGENT_ENGINES, type AgentEngine } from './engineSettings.js';
import { parse } from './validate.js';
import { ValidationError } from './errors.js';
import { nowIso } from './time.js';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** One agent role's engine choice. model/effort omitted = the engine's own default. */
export interface ModelProfile { engine: AgentEngine; model?: string; effort?: Effort }

export interface AgentModelStages { description?: ModelProfile; plan?: ModelProfile; implementation?: ModelProfile }

/** Settings for the roles. Every key is optional: a missing one falls through to the next layer. */
export interface AgentModelLayer {
  stages?: AgentModelStages;
  /** Ordered; 1..4; distinct engine+model pairs. A workspace replaces the whole list. */
  reviewers?: ModelProfile[];
  /** Overrides reviewer.config consensus.enabled; its timing stays file-driven. Global only. */
  consensus?: boolean;
  visualization?: ModelProfile;
  feedbackEval?: ModelProfile;
}
export type WorkspaceModelLayer = Omit<AgentModelLayer, 'consensus'>;

/** The stored document (app_kv 'agent_models'). */
export interface AgentModels {
  global: AgentModelLayer;
  workspaces: Record<string, WorkspaceModelLayer>;
}

export type AgentModelRole = 'description' | 'plan' | 'implementation' | 'visualization' | 'feedbackEval';

/** Display-only catalogue (dropdown labels + order). Supervisors never check an id against it. */
export const MODEL_CATALOG: ReadonlyArray<{ engine: AgentEngine; id: string; label: string }> = [
  { engine: 'claude', id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { engine: 'claude', id: 'claude-sonnet-5-5', label: 'Sonnet 5.5' },
  { engine: 'claude', id: 'claude-haiku-5-5', label: 'Haiku 5.5' },
  { engine: 'claude', id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { engine: 'codex', id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' },
  { engine: 'codex', id: 'gpt-6-sol', label: 'GPT-6 Sol' },
  { engine: 'codex', id: 'gpt-6-astra', label: 'GPT-6 Astra' },
  { engine: 'codex', id: 'gpt-6-luna', label: 'GPT-6 Luna' },
];

/** Excludes spaces, quotes, `=`, `;`, `&`, `|`, `%`, `^`, newlines and a leading `-` (§8). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
export const MAX_REVIEWERS = 4;

const KV_KEY = 'agent_models';
const DEFAULTS_KV_KEY = 'agent_model_defaults';
const MAX_DEFAULT_REPORTS = 50;

const modelId = z.string().regex(MODEL_ID_PATTERN, 'model id may only use letters, digits and . _ : [ ] - (max 80, starting alphanumeric)');
const profileSchema = z.object({
  engine: z.enum(AGENT_ENGINES),
  model: modelId.optional(),
  effort: z.enum(EFFORTS).optional(),
}).strict();
const stagesSchema = z.object({ description: profileSchema.optional(), plan: profileSchema.optional(), implementation: profileSchema.optional() }).strict();
const reviewersSchema = z.array(profileSchema).min(1).max(MAX_REVIEWERS, `at most ${MAX_REVIEWERS} reviewers`).refine(
  (ps) => new Set(ps.map((p) => JSON.stringify([p.engine, p.model ?? null]))).size === ps.length,
  'reviewers must have distinct engine/model pairs',
);
const workspaceLayerSchema = z.object({
  stages: stagesSchema.optional(),
  reviewers: reviewersSchema.optional(),
  visualization: profileSchema.optional(),
  feedbackEval: profileSchema.optional(),
}).strict();
const globalLayerSchema = workspaceLayerSchema.extend({ consensus: z.boolean().optional() }).strict();
const agentModelsSchema = z.object({ global: globalLayerSchema, workspaces: z.record(workspaceLayerSchema) }).strict();

export const emptyAgentModels = (): AgentModels => ({ global: {}, workspaces: {} });

/** Drop undefined fields and empty containers so a cleared setting leaves no trace in the store. */
function compactLayer<T extends AgentModelLayer>(layer: T): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(layer)) {
    if (v === undefined) continue;
    if (k === 'stages') {
      const stages = Object.fromEntries(Object.entries(v as object).filter(([, p]) => p !== undefined));
      if (Object.keys(stages).length > 0) out[k] = stages;
    } else out[k] = v;
  }
  return out as T;
}

function compact(doc: z.output<typeof agentModelsSchema>): AgentModels {
  const workspaces: Record<string, WorkspaceModelLayer> = {};
  for (const [name, layer] of Object.entries(doc.workspaces)) {
    const c = compactLayer(layer as WorkspaceModelLayer);
    if (Object.keys(c).length > 0) workspaces[name] = c;
  }
  return { global: compactLayer(doc.global as AgentModelLayer), workspaces };
}

/** Normalize untrusted JSON into a valid document; anything invalid reads as empty. */
export function normalizeAgentModels(obj: unknown): AgentModels {
  const r = agentModelsSchema.safeParse(obj);
  return r.success ? compact(r.data) : emptyAgentModels();
}

/** The stored document, with corrupt values normalized and deleted workspaces' overrides dropped. */
export function getAgentModels(db: DB): AgentModels {
  const raw = getKv(db, KV_KEY);
  if (!raw) return emptyAgentModels();
  let doc: AgentModels;
  try { doc = normalizeAgentModels(JSON.parse(raw)); } catch { return emptyAgentModels(); }
  const names = new Set(listWorkspaces(db).map((w) => w.name));
  doc.workspaces = Object.fromEntries(Object.entries(doc.workspaces).filter(([name]) => names.has(name)));
  return doc;
}

/** Validate and replace the WHOLE document (a save always sends it all; a newer save wins). */
export function setAgentModels(db: DB, input: unknown): AgentModels {
  const doc = compact(parse(agentModelsSchema, input));
  const names = new Set(listWorkspaces(db).map((w) => w.name));
  const unknown = Object.keys(doc.workspaces).filter((name) => !names.has(name));
  if (unknown.length > 0) throw new ValidationError(`unknown workspace: ${unknown.join(', ')}`);
  setKv(db, KV_KEY, JSON.stringify(doc));
  return doc;
}

const stageRole = (role: AgentModelRole): role is 'description' | 'plan' | 'implementation' =>
  role === 'description' || role === 'plan' || role === 'implementation';

function fromLayer(layer: AgentModelLayer | undefined, role: AgentModelRole): ModelProfile | undefined {
  if (!layer) return undefined;
  if (!stageRole(role)) return layer[role];
  // legacy plan stage: an unset plan uses this layer's description profile
  return role === 'plan' ? (layer.stages?.plan ?? layer.stages?.description) : layer.stages?.[role];
}

/**
 * The effective profile for a role: workspace override → board global → `fileDefault` → null.
 * Without `fileDefault`, null means "the board sets nothing for this role": the caller keeps its
 * config-file behaviour unchanged.
 */
export function resolveAgentModel(models: AgentModels, role: AgentModelRole, workspace: string, fileDefault: ModelProfile | null = null): ModelProfile | null {
  return fromLayer(models.workspaces[workspace], role) ?? fromLayer(models.global, role) ?? fileDefault;
}

/** The reviewer list, replaced whole: workspace list → board global list → `fileReviewers` → null. */
export function resolveReviewers<T = ModelProfile>(models: AgentModels, workspace: string, fileReviewers?: T[]): ModelProfile[] | T[] | null {
  return models.workspaces[workspace]?.reviewers ?? models.global.reviewers ?? fileReviewers ?? null;
}

/** A profile's CLI flags, appended after the engine's global args. Unset fields add nothing. */
export function modelProfileArgs(profile: ModelProfile): string[] {
  const args: string[] = [];
  if (profile.engine === 'claude') {
    if (profile.model) args.push('--model', profile.model);
    if (profile.effort) args.push('--effort', profile.effort);
  } else {
    if (profile.model) args.push('-m', profile.model);
    // the -c value is TOML; the codex spawn path never goes through cmd.exe (dispatcher codex.ts)
    if (profile.effort) args.push('-c', `model_reasoning_effort="${profile.effort}"`);
  }
  return args;
}

// ── config-file defaults, reported by supervisors so the board can show them (§6) ──────────────

/** A profile as a config file describes it. Not held to the board's model-id rule (file values are
 *  the operator's own), and `extraArgs` keeps any stage args that are not model/effort visible. */
export interface ReportedProfile { engine: AgentEngine; model?: string; effort?: string; extraArgs?: string[] }
export interface ReportedRoles {
  stages?: { description?: ReportedProfile; plan?: ReportedProfile; implementation?: ReportedProfile };
  reviewers?: ReportedProfile[];
  consensus?: boolean;
  visualization?: ReportedProfile;
  feedbackEval?: ReportedProfile;
}
export interface AgentModelDefaultsReport { supervisor: string; kind: 'dispatcher' | 'reviewer'; roles: ReportedRoles }
export type AgentModelDefaults = Record<string, { kind: 'dispatcher' | 'reviewer'; at: string; roles: ReportedRoles }>;

const reportedProfileSchema = z.object({
  engine: z.enum(AGENT_ENGINES),
  model: z.string().min(1).max(200).optional(),
  effort: z.string().min(1).max(40).optional(),
  extraArgs: z.array(z.string().max(1000)).max(50).optional(),
}).strict();
const reportedRolesSchema = z.object({
  stages: z.object({ description: reportedProfileSchema.optional(), plan: reportedProfileSchema.optional(), implementation: reportedProfileSchema.optional() }).strict().optional(),
  reviewers: z.array(reportedProfileSchema).max(16).optional(),
  consensus: z.boolean().optional(),
  visualization: reportedProfileSchema.optional(),
  feedbackEval: reportedProfileSchema.optional(),
}).strict();
const reportSchema = z.object({ supervisor: z.string().min(1).max(100), kind: z.enum(['dispatcher', 'reviewer']), roles: reportedRolesSchema }).strict();
const storedDefaultsSchema = z.record(z.object({ kind: z.enum(['dispatcher', 'reviewer']), at: z.string(), roles: reportedRolesSchema }).strict());

export function getAgentModelDefaults(db: DB): AgentModelDefaults {
  const raw = getKv(db, DEFAULTS_KV_KEY);
  if (!raw) return {};
  try {
    const r = storedDefaultsSchema.safeParse(JSON.parse(raw));
    return r.success ? (r.data as AgentModelDefaults) : {};
  } catch { return {}; }
}

/** Store one supervisor's config-file defaults, stamped with the time it arrived. Informational. */
export function reportAgentModelDefaults(db: DB, input: unknown, now: () => string = nowIso): AgentModelDefaults {
  const report = parse(reportSchema, input) as AgentModelDefaultsReport;
  const all = getAgentModelDefaults(db);
  all[report.supervisor] = { kind: report.kind, at: now(), roles: report.roles };
  // bounded: keep the most recent reports when many supervisor names have come and gone
  const kept = Object.entries(all).sort(([, a], [, b]) => b.at.localeCompare(a.at)).slice(0, MAX_DEFAULT_REPORTS);
  const out = Object.fromEntries(kept);
  setKv(db, DEFAULTS_KV_KEY, JSON.stringify(out));
  return out;
}

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, '$2');

/**
 * The profile a config file describes for one stage: `engine` plus the model and effort parsed
 * from `<engine global args> + <stage args>` (last value wins, as on the CLI). Claude reads
 * `--model`/`--effort`; Codex reads `-m`/`--model`, `-c model=…` and `-c model_reasoning_effort=…`.
 * Stage args that are not model/effort go to `extraArgs`, since a board setting drops them.
 */
export function profileFromArgs(engine: AgentEngine, globalArgs: readonly string[], stageArgs: readonly string[]): ReportedProfile {
  const all = [...globalArgs, ...stageArgs];
  const stageFrom = globalArgs.length;
  let model: string | undefined;
  let effort: string | undefined;
  const extra: string[] = [];
  for (let i = 0; i < all.length; i++) {
    const a = all[i]!;
    const next = all[i + 1];
    const keep = (n: number): void => { if (i >= stageFrom) extra.push(...all.slice(i, i + n)); };
    const eq = a.indexOf('=');
    const flag = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    const inline = flag !== a ? a.slice(eq + 1) : undefined;
    const value = inline ?? next;
    const width = inline !== undefined ? 1 : 2;
    if (engine === 'claude' && (flag === '--model' || flag === '--effort') && value !== undefined) {
      if (flag === '--model') model = value; else effort = value;
      i += width - 1;
    } else if (engine === 'codex' && (flag === '-m' || flag === '--model') && value !== undefined) {
      model = value;
      i += width - 1;
    } else if (engine === 'codex' && (a === '-c' || a === '--config') && next !== undefined) {
      const m = /^\s*(model|model_reasoning_effort)\s*=\s*(.+?)\s*$/.exec(next);
      if (m?.[1] === 'model') model = unquote(m[2]!);
      else if (m) effort = unquote(m[2]!);
      else keep(2);
      i += 1;
    } else keep(1);
  }
  return { engine, ...(model ? { model } : {}), ...(effort ? { effort } : {}), ...(extra.length ? { extraArgs: extra } : {}) };
}
