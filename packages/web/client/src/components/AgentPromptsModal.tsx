import { useEffect, useState } from 'react';
import type { AgentPrompts, EngineSettings, AgentEngine } from '../types.js';
import { api } from '../api.js';
import { AGENT_PROMPT_FIELDS } from '../agentPromptMeta.js';

const ENGINE_TOGGLES: ReadonlyArray<{ key: AgentEngine; label: string }> = [
  { key: 'claude', label: 'Claude enabled' },
  { key: 'codex', label: 'Codex enabled' },
];

/** Edit the GLOBAL default agent system prompts. A workspace can override any of these per repo
 *  (Workspaces modal). Effective prompt an agent runs with = workspace override ?? global ?? ''. */
export function AgentPromptsModal({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [engines, setEngines] = useState<EngineSettings | null>(null);

  useEffect(() => {
    api.getEngineSettings().then(setEngines).catch((e: Error) => setErr(e.message));
  }, []);

  // Toggles apply immediately (no Save): the dispatcher re-reads them every tick, so a stage
  // configured for a disabled engine falls back to the other one on its next spawn.
  const toggleEngine = (engine: AgentEngine, enabled: boolean) => {
    setErr(null);
    api.setEngineSettings({ [engine]: { enabled } })
      .then(setEngines)
      .catch((e: Error) => setErr(e.message));
  };

  useEffect(() => {
    api.getAgentPrompts()
      .then((p: AgentPrompts) => setValues(Object.fromEntries(AGENT_PROMPT_FIELDS.map((f) => [f.key, p[f.key] ?? '']))))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const set = (k: string, v: string) => setValues((prev) => ({ ...prev, [k]: v }));

  const handleSave = () => {
    setSaving(true);
    setErr(null);
    // blank values clear that key on the server (the agent falls back to built-in behavior).
    api.setAgentPrompts(values)
      .then(() => onClose())
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div className="af-overlay">
      <div className="af-modal" style={{ padding: '18px 20px', width: 'min(94vw, 1180px)', maxWidth: '1180px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Agent system prompts</h3>
          <button className="af-x" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--ink-3)', margin: '6px 0 12px' }}>
          Global defaults for each agent. A workspace can override any of these in its own settings; blank = built-in behavior.
        </p>
        <div className="af-engines" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px 18px', padding: '10px 12px', marginBottom: '14px', border: '1px solid var(--line-soft)', borderRadius: '9px', background: 'var(--bg-deep)' }}>
          <span style={{ fontWeight: 600, fontSize: '13px' }}>Engines</span>
          {ENGINE_TOGGLES.map((e) => (
            <label key={e.key} style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', fontSize: '12.5px' }}>
              <input
                type="checkbox"
                checked={engines?.[e.key].enabled ?? true}
                disabled={engines === null}
                onChange={(ev) => toggleEngine(e.key, ev.target.checked)}
              />
              {e.label}
            </label>
          ))}
          <span style={{ flexBasis: '100%', fontSize: '12px', color: 'var(--ink-3)' }}>
            Applies live. A stage configured for a disabled engine runs on the other one (with that engine's global args only); with both off, queued tasks wait.
          </span>
        </div>
        {loading ? (
          <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', maxHeight: '72vh', overflowY: 'auto', paddingRight: '4px' }}>
            {AGENT_PROMPT_FIELDS.map((f) => (
              <div key={f.key} style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <label style={{ fontWeight: 600, fontSize: '13px' }}>{f.label}</label>
                  <button
                    className="af-mini"
                    style={{ height: 24, padding: '0 8px', fontSize: '11px' }}
                    onClick={() => set(f.key, f.example)}
                    title="Fill this field with an editable example — tweak it, then Save."
                  >
                    Insert example
                  </button>
                </div>
                <span style={{ fontSize: '12px', color: 'var(--ink-3)' }}>{f.hint}</span>
                <textarea
                  aria-label={f.label}
                  value={values[f.key] ?? ''}
                  onChange={(e) => set(f.key, e.target.value)}
                  rows={7}
                  placeholder="(inherit built-in behavior)"
                  style={{ padding: '6px 10px', resize: 'vertical', fontFamily: 'inherit' }}
                />
              </div>
            ))}
          </div>
        )}
        {err && <div className="af-err" style={{ marginTop: '8px' }}>{err}</div>}
        <div style={{ marginTop: '12px' }}>
          <button className="af-btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
