import type { AgentEngine, AgentModelDefaults, AgentModelLayer, Effort, EngineSettings, ModelProfile, ReportedProfile } from './types.js';

// Mirrors of core's agentModels.ts constants. The client bundle never imports core's runtime
// (it pulls in node:sqlite); the server re-validates every save, so a drift only costs a 400.
export const EFFORTS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,79}$/;
export const MAX_REVIEWERS = 4;

export const ENGINE_LABEL: Record<AgentEngine, string> = { claude: 'Claude', codex: 'Codex' };
export const otherEngine = (e: AgentEngine): AgentEngine => (e === 'claude' ? 'codex' : 'claude');

/** The single-profile roles the Models tab edits (review is a list, handled on its own). */
export type ProfileRole = 'description' | 'implementation' | 'visualization' | 'feedbackEval';
export const ROLE_LABEL: Record<ProfileRole | 'review', string> = {
  description: 'Spec',
  implementation: 'Implementation',
  review: 'Review',
  visualization: 'Change visualization',
  feedbackEval: 'PR feedback evaluator',
};

export function getRole(layer: AgentModelLayer | undefined, role: ProfileRole): ModelProfile | undefined {
  if (!layer) return undefined;
  return role === 'description' || role === 'implementation' ? layer.stages?.[role] : layer[role];
}

/** A copy of `layer` with one role set (or cleared, with `undefined`). Empty `stages` is dropped. */
export function withRole<T extends AgentModelLayer>(layer: T, role: ProfileRole, profile: ModelProfile | undefined): T {
  const next: AgentModelLayer = { ...layer };
  if (role === 'description' || role === 'implementation') {
    const stages = { ...(layer.stages ?? {}) };
    if (profile) stages[role] = profile; else delete stages[role];
    if (Object.keys(stages).length > 0) next.stages = stages; else delete next.stages;
  } else if (profile) next[role] = profile;
  else delete next[role];
  return next as T;
}

/** `engine` + its effort as a board profile (a reported effort outside the list is dropped). */
export function toProfile(p: ReportedProfile | ModelProfile): ModelProfile {
  const effort = (EFFORTS as readonly string[]).includes(p.effort ?? '') ? (p.effort as Effort) : undefined;
  return { engine: p.engine, ...(p.model ? { model: p.model } : {}), ...(effort ? { effort } : {}) };
}

/** The parts of the command line this feature controls, e.g. `claude -p --model x --effort high`. */
export function commandPreview(p: ModelProfile): string {
  if (p.engine === 'claude') return ['claude -p', p.model && `--model ${p.model}`, p.effort && `--effort ${p.effort}`].filter(Boolean).join(' ');
  return ['codex exec', p.model && `-m ${p.model}`, p.effort && `-c model_reasoning_effort="${p.effort}"`].filter(Boolean).join(' ');
}

export function describeProfile(p: ModelProfile | ReportedProfile, catalog: ReadonlyArray<{ id: string; label: string }> = []): string {
  const model = p.model ? (catalog.find((m) => m.id === p.model)?.label ?? p.model) : 'default model';
  return [ENGINE_LABEL[p.engine], model, p.effort].filter(Boolean).join(' · ');
}

export const modelIdError = (model: string | undefined): string | null =>
  model === undefined || MODEL_ID_PATTERN.test(model) ? null : 'Use letters, digits and . _ : [ ] - only (max 80, starting with a letter or digit).';

export function reviewerListError(list: ModelProfile[]): string | null {
  const keys = list.map((p) => `${p.engine}/${p.model ?? ''}`);
  if (new Set(keys).size !== keys.length) return 'Two reviewers use the same engine and model.';
  return list.map((p) => modelIdError(p.model)).find((e) => e !== null) ?? null;
}

export type FileDefault =
  | { kind: 'none' }
  | { kind: 'varies' }
  | { kind: 'one'; file: string; supervisors: string[]; value: ReportedProfile | ReportedProfile[] | boolean };

type DefaultKey = ProfileRole | 'reviewers' | 'consensus';

/** What the supervisors' config files set for a role (§6): one value, "varies", or no report yet. */
export function fileDefault(defaults: AgentModelDefaults, key: DefaultKey): FileDefault {
  const kind = key === 'description' || key === 'implementation' ? 'dispatcher' : 'reviewer';
  const hits: Array<{ name: string; value: ReportedProfile | ReportedProfile[] | boolean }> = [];
  for (const [name, report] of Object.entries(defaults)) {
    if (report.kind !== kind) continue;
    const r = report.roles;
    const value = key === 'description' || key === 'implementation' ? r.stages?.[key] : r[key];
    if (value !== undefined) hits.push({ name, value });
  }
  if (hits.length === 0) return { kind: 'none' };
  const first = JSON.stringify(hits[0]!.value);
  if (hits.some((h) => JSON.stringify(h.value) !== first)) return { kind: 'varies' };
  return { kind: 'one', file: `${kind}.config.json`, supervisors: hits.map((h) => h.name), value: hits[0]!.value };
}

export function sourceText(d: FileDefault): string {
  if (d.kind === 'none') return 'Uses the config file (no supervisor has reported yet)';
  if (d.kind === 'varies') return 'from the config files · varies by supervisor';
  return `from ${d.file} · ${d.supervisors.join(', ')}`;
}

/** What actually runs when a step's engine is switched off (§5.3), or null when it is on. */
export function engineOffNote(engine: AgentEngine, engines: EngineSettings | null): string | null {
  if (!engines || engines[engine].enabled) return null;
  const other = otherEngine(engine);
  if (!engines[other].enabled) return 'Both engines are switched off: this step waits until one is back on.';
  return `${ENGINE_LABEL[engine]} is switched off: this step runs on ${ENGINE_LABEL[other]} at its default model and effort.`;
}

export function reviewerOffNote(list: ModelProfile[], index: number, engines: EngineSettings | null, catalog: ReadonlyArray<{ id: string; label: string }> = []): string | null {
  const p = list[index];
  if (!p || !engines || engines[p.engine].enabled) return null;
  const remaining = list.filter((r) => engines[r.engine].enabled);
  if (remaining.length === 0) return `${ENGINE_LABEL[p.engine]} is switched off: no reviewer can run, so reviews wait.`;
  if (remaining.length === 1) return `${ENGINE_LABEL[p.engine]} is switched off: this reviewer is skipped and ${describeProfile(remaining[0]!, catalog)} reviews alone.`;
  return `${ENGINE_LABEL[p.engine]} is switched off: this reviewer is skipped.`;
}
