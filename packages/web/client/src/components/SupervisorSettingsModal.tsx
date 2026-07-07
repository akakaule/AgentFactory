import { useEffect, useState, type ReactElement } from 'react';
import { api } from '../api.js';
import { SUPERVISOR_META, deserialize, serialize, type SettingField } from '../supervisorSettingsMeta.js';

/** Edit the board-editable supervisor settings (dispatcher/reviewer/watcher). Overrides the file
 *  config's tunable knobs live — each supervisor re-reads them on its next poll, no restart. */
export function SupervisorSettingsModal({ onClose }: { onClose: () => void }) {
  const [values, setValues] = useState<Record<string, Record<string, string>>>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    api.getSupervisorSettings()
      .then((all) => {
        const next: Record<string, Record<string, string>> = {};
        for (const sec of SUPERVISOR_META) next[sec.kind] = deserialize(sec.fields, all[sec.kind] ?? {});
        setValues(next);
      })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setLoading(false));
  }, []);

  const set = (kind: string, key: string, v: string) =>
    setValues((prev) => ({ ...prev, [kind]: { ...(prev[kind] ?? {}), [key]: v } }));

  const handleSave = async () => {
    setSaving(true);
    setErr(null);
    try {
      // PUT each kind (replace semantics): blank fields are omitted → inherit the file default.
      for (const sec of SUPERVISOR_META) {
        await api.setSupervisorSettings(sec.kind, serialize(sec.fields, values[sec.kind] ?? {}));
      }
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="af-overlay">
      <div className="af-modal" style={{ padding: 16, maxWidth: 860 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Supervisor settings</h3>
          <button className="af-x" onClick={onClose}>✕</button>
        </div>
        <p style={{ fontSize: 12, color: 'var(--ink-3)', margin: '6px 0 12px' }}>
          Live overrides for the dispatcher / reviewer / watcher — applied on their next poll, no restart.
          Blank = inherit the config-file default. The DB path and secrets stay in the file.
        </p>
        {loading ? (
          <div style={{ color: 'var(--ink-3)' }}>Loading…</div>
        ) : (
          <div style={{ maxHeight: '62vh', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 18 }}>
            {SUPERVISOR_META.map((sec) => (
              <section key={sec.kind}>
                <h4 style={{ margin: '0 0 8px' }}>{sec.title}</h4>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                  {sec.fields.map((f) => (
                    <Field key={f.key} f={f} value={values[sec.kind]?.[f.key] ?? ''} onChange={(v) => set(sec.kind, f.key, v)} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        )}
        {err && <div className="af-err" style={{ marginTop: 8 }}>{err}</div>}
        <div style={{ marginTop: 12 }}>
          <button className="af-btn-primary" onClick={handleSave} disabled={saving || loading}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({ f, value, onChange }: { f: SettingField; value: string; onChange: (v: string) => void }): ReactElement {
  const inputStyle = { padding: '5px 8px', width: '100%' } as const;
  let control: ReactElement;
  if (f.type === 'select') {
    control = (
      <select aria-label={f.label} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        {(f.options ?? []).map((o) => (
          <option key={o} value={o}>{o === '' ? '(inherit)' : o}</option>
        ))}
      </select>
    );
  } else if (f.type === 'boolean') {
    control = (
      <select aria-label={f.label} value={value} onChange={(e) => onChange(e.target.value)} style={inputStyle}>
        <option value="">(inherit)</option>
        <option value="true">on</option>
        <option value="false">off</option>
      </select>
    );
  } else {
    control = (
      <input
        aria-label={f.label}
        type={f.type === 'number' ? 'number' : 'text'}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={f.placeholder ?? (f.type === 'list' ? 'comma, separated' : '')}
        style={inputStyle}
      />
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <label style={{ fontSize: 12, fontWeight: 600 }}>{f.label}</label>
      {control}
      {f.hint && <span style={{ fontSize: 11, color: 'var(--ink-3)' }}>{f.hint}</span>}
    </div>
  );
}
