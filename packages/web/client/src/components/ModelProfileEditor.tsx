import { useState } from 'react';
import type { AgentEngine, Effort, ModelCatalogEntry, ModelProfile } from '../types.js';
import { EFFORTS, ENGINE_LABEL, commandPreview, modelIdError } from '../agentModelMeta.js';

const CUSTOM = '__custom__';

/** Engine switch + model dropdown (catalogue, or a custom id checked live) + effort + command preview.
 *  `label` names the role for the controls' accessible names ("Spec engine", "Spec model", …). */
export function ModelProfileEditor({ label, value, catalog, onChange }: {
  label: string;
  value: ModelProfile;
  catalog: ModelCatalogEntry[];
  onChange: (next: ModelProfile) => void;
}) {
  const options = catalog.filter((m) => m.engine === value.engine);
  const inCatalog = value.model === undefined || options.some((m) => m.id === value.model);
  const [custom, setCustom] = useState(!inCatalog);
  const showCustom = custom || !inCatalog;
  const err = modelIdError(value.model);

  const set = (patch: { model?: string | undefined; effort?: Effort | undefined }) => {
    const next = { ...value, ...patch } as ModelProfile;
    for (const k of ['model', 'effort'] as const) if (next[k] === undefined || next[k] === '') delete next[k];
    onChange(next);
  };
  // a model id belongs to its engine: switching engine resets the model to that engine's default
  const setEngine = (engine: AgentEngine) => {
    if (engine === value.engine) return;
    setCustom(false);
    const next: ModelProfile = { engine };
    if (value.effort) next.effort = value.effort;
    onChange(next);
  };

  return (
    <div className="af-mp">
      <div className="af-mp-row">
        <span className="af-mp-k">Engine</span>
        <div className="af-seg" role="group" aria-label={`${label} engine`}>
          {(['claude', 'codex'] as const).map((e) => (
            <button key={e} type="button" aria-pressed={value.engine === e} className={value.engine === e ? 'on' : ''} onClick={() => setEngine(e)}>
              {ENGINE_LABEL[e]}
            </button>
          ))}
        </div>
      </div>
      <div className="af-mp-row">
        <label className="af-mp-k" htmlFor={`${label}-model`}>Model</label>
        <select
          id={`${label}-model`}
          aria-label={`${label} model`}
          value={showCustom ? CUSTOM : (value.model ?? '')}
          onChange={(e) => {
            if (e.target.value === CUSTOM) { setCustom(true); return; }
            setCustom(false);
            set({ model: e.target.value || undefined });
          }}
        >
          <option value="">Engine default</option>
          {options.map((m) => <option key={m.id} value={m.id}>{m.label} ({m.id})</option>)}
          <option value={CUSTOM}>Custom model id…</option>
        </select>
        {showCustom && (
          <input
            type="text"
            className="mono"
            aria-label={`${label} custom model id`}
            aria-invalid={err !== null}
            value={value.model ?? ''}
            placeholder="e.g. claude-opus-5-5[1m]"
            onChange={(e) => set({ model: e.target.value || undefined })}
          />
        )}
      </div>
      {err && <div className="af-err" role="alert">{err}</div>}
      <div className="af-mp-row">
        <span className="af-mp-k">Effort</span>
        <div className="af-seg" role="group" aria-label={`${label} effort`}>
          <button type="button" aria-pressed={value.effort === undefined} className={value.effort === undefined ? 'on' : ''} onClick={() => set({ effort: undefined })}>Default</button>
          {EFFORTS.map((e: Effort) => (
            <button key={e} type="button" aria-pressed={value.effort === e} className={value.effort === e ? 'on' : ''} onClick={() => set({ effort: e })}>{e}</button>
          ))}
        </div>
      </div>
      <code className="af-mp-cmd mono">{commandPreview(value)}</code>
    </div>
  );
}
