/**
 * Configurable per-agent system prompts. A fixed set of prompt keys (one per pipeline-stage worker,
 * the reviewer, and the delivering-feedback evaluator) each carry a free-text system prompt with
 * GLOBAL defaults (stored as a JSON blob in app_kv) and optional PER-WORKSPACE overrides (the
 * workspace.prompt_overrides JSON column). The effective prompt an agent runs with is
 * `workspace override ?? global default ?? ''` — see resolveAgentPrompt, the single seam the
 * dispatcher (worker), reviewer, and evaluator all resolve through.
 */
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';
import { findWorkspaceByName } from './repo/workspaces.js';

/** The agents whose system prompt is configurable. The config UI renders one field per key. */
export const AGENT_PROMPT_KEYS = [
  'worker.description',
  'worker.plan',
  'worker.implementation',
  'reviewer',
  'delivering-evaluator',
] as const;

export type AgentPromptKey = (typeof AGENT_PROMPT_KEYS)[number];
/** A (possibly partial) map of prompt keys to their configured system-prompt text. */
export type AgentPrompts = Partial<Record<AgentPromptKey, string>>;

const KV_KEY = 'agent_prompts';

export function isAgentPromptKey(k: string): k is AgentPromptKey {
  return (AGENT_PROMPT_KEYS as readonly string[]).includes(k);
}

/** Keep only known keys with a non-empty trimmed string value; tolerate malformed JSON. */
export function normalizePrompts(obj: unknown): AgentPrompts {
  const out: AgentPrompts = {};
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (isAgentPromptKey(k) && typeof v === 'string' && v.trim() !== '') out[k] = v.trim();
  }
  return out;
}

function parseStored(raw: string | null): AgentPrompts {
  if (!raw) return {};
  try { return normalizePrompts(JSON.parse(raw)); } catch { return {}; }
}

/** The global default prompts (app_kv, JSON). Blank/unknown keys are simply absent. */
export function getGlobalPrompts(db: DB): AgentPrompts {
  return parseStored(getKv(db, KV_KEY));
}

/** Merge a partial update into the global prompts; a key set to blank/null clears it. Returns the new set. */
export function setGlobalPrompts(db: DB, partial: Record<string, string | null | undefined>): AgentPrompts {
  const current = getGlobalPrompts(db);
  for (const [k, v] of Object.entries(partial)) {
    if (!isAgentPromptKey(k)) continue;
    const t = typeof v === 'string' ? v.trim() : '';
    if (t === '') delete current[k]; else current[k] = t;
  }
  setKv(db, KV_KEY, JSON.stringify(current));
  return current;
}

/** The per-workspace prompt overrides (workspace.prompt_overrides JSON), normalized. */
export function getWorkspacePromptOverrides(db: DB, workspace: string): AgentPrompts {
  const row = findWorkspaceByName(db, workspace);
  return parseStored(row?.prompt_overrides ?? null);
}

/** Effective system prompt for an agent role in a workspace: workspace override → global → ''. */
export function resolveAgentPrompt(db: DB, key: AgentPromptKey, workspace: string): string {
  const override = getWorkspacePromptOverrides(db, workspace)[key];
  if (override) return override;
  return getGlobalPrompts(db)[key] ?? '';
}
