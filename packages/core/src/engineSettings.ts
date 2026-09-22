/**
 * Board-wide agent engine availability (app_kv, JSON). An operator disables an engine on the
 * board when it cannot run — Codex out of credits, a CLI broken by an update — and supervisors
 * read the setting every tick, so a disabled engine's stages fall back to the other engine
 * without a config edit or restart. Absent/malformed state means "everything enabled".
 */
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';

export const AGENT_ENGINES = ['claude', 'codex'] as const;
export type AgentEngine = (typeof AGENT_ENGINES)[number];
export type EngineSettings = Record<AgentEngine, { enabled: boolean }>;

const KV_KEY = 'engine_settings';

export function isAgentEngine(e: string): e is AgentEngine {
  return (AGENT_ENGINES as readonly string[]).includes(e);
}

export const defaultEngineSettings = (): EngineSettings => ({ claude: { enabled: true }, codex: { enabled: true } });

/** Normalize untrusted JSON into a complete settings object; unknown engines are dropped, missing ones enabled. */
export function normalizeEngineSettings(obj: unknown): EngineSettings {
  const out = defaultEngineSettings();
  if (!obj || typeof obj !== 'object') return out;
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    if (!isAgentEngine(k) || !v || typeof v !== 'object') continue;
    const enabled = (v as { enabled?: unknown }).enabled;
    if (typeof enabled === 'boolean') out[k] = { enabled };
  }
  return out;
}

export function getEngineSettings(db: DB): EngineSettings {
  const raw = getKv(db, KV_KEY);
  if (!raw) return defaultEngineSettings();
  try { return normalizeEngineSettings(JSON.parse(raw)); } catch { return defaultEngineSettings(); }
}

/** Merge a partial update ({ codex: { enabled: false } }) into the stored settings; returns the new set. */
export function setEngineSettings(db: DB, partial: unknown): EngineSettings {
  const current = getEngineSettings(db);
  if (partial && typeof partial === 'object') {
    for (const [k, v] of Object.entries(partial as Record<string, unknown>)) {
      if (!isAgentEngine(k) || !v || typeof v !== 'object') continue;
      const enabled = (v as { enabled?: unknown }).enabled;
      if (typeof enabled === 'boolean') current[k] = { enabled };
    }
  }
  setKv(db, KV_KEY, JSON.stringify(current));
  return current;
}

/**
 * The engine a stage actually runs on: the configured one when enabled, otherwise the other
 * engine when that is enabled, otherwise null (nothing can run — the caller leaves the task
 * queued rather than burning an attempt).
 */
export function resolveEngine(configured: AgentEngine, settings: EngineSettings): AgentEngine | null {
  if (settings[configured].enabled) return configured;
  const fallback = AGENT_ENGINES.find((e) => e !== configured && settings[e].enabled);
  return fallback ?? null;
}
