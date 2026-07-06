import { useEffect, useState } from 'react';
import type { AgentPrompts } from '../types.js';
import { api } from '../api.js';
import { AGENT_PROMPT_FIELDS } from '../agentPromptMeta.js';

/** Edit the GLOBAL default agent system prompts. A workspace can override any of these per repo
 *  (Workspaces modal). Effective prompt an agent runs with = workspace override ?? global ?? ''. */
export function AgentPromptsModal({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

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
      <div className="af-modal" style={{ padding: '16px', maxWidth: '760px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Agent system prompts</h3>
          <button className="af-x" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: '12px', color: 'var(--ink-3)', margin: '6px 0 12px' }}>
          Global defaults for each agent. A workspace can override any of these in its own settings; blank = built-in behavior.
        </p>
        {loading ? (
          <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', maxHeight: '60vh', overflowY: 'auto' }}>
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
                  rows={3}
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
