import { useEffect, useMemo, useState } from 'react';
import type { IntakeSettings, Workspace } from '../types.js';
import { api } from '../api.js';

const sameSet = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join('\0') === [...b].sort().join('\0');

export function IntakeSettingsPanel({ workspaces, onSaved, onClose }: { workspaces: Workspace[]; onSaved: () => void; onClose: () => void }) {
  const [saved, setSaved] = useState<IntakeSettings | null>(null);
  const [settings, setSettings] = useState<IntakeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  useEffect(() => {
    void api.getIntakeSettings().then((s) => { setSaved(s); setSettings(s); }).catch((e: Error) => setError(e.message));
  }, []);

  // Saved opt-ins first, then alphabetical. Ordered by the SAVED selection so tiles never jump
  // under the cursor while editing.
  const ordered = useMemo(() => {
    const optedIn = new Set(saved?.workspaces ?? []);
    return workspaces.map((w) => w.name).sort((a, b) =>
      optedIn.has(a) === optedIn.has(b) ? a.localeCompare(b) : optedIn.has(a) ? -1 : 1);
  }, [workspaces, saved]);

  if (!settings || !saved) {
    return <div className="af-overlay"><div className="af-modal af-intake-modal"><div className="af-intake-body">{error ?? 'Loading intake settings…'}</div></div></div>;
  }

  const off = settings.mode === 'off';
  const dirty = settings.mode !== saved.mode || settings.sendWorkspacePolicy !== saved.sendWorkspacePolicy
    || !sameSet(settings.workspaces, saved.workspaces);
  const query = filter.trim().toLowerCase();
  const shown = ordered.filter((name) => name.toLowerCase().includes(query));
  const setMode = (mode: IntakeSettings['mode']) => setSettings({ ...settings, mode });
  const setWorkspaces = (names: string[]) => setSettings({ ...settings, workspaces: names });

  return (
    <div className="af-overlay">
      <div className="af-modal af-intake-modal" role="dialog" aria-modal="true" aria-label="Task Intelligence settings">
        <div className="af-intake-mhead">
          <div>
            <h3>Task Intelligence</h3>
            <p>Scores each task's readiness, complexity and risk before an agent claims it. Advisory only — it never blocks work.</p>
          </div>
          <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="af-intake-body">
          <div className="af-intake-row">
            <div className="txt">
              <div className="lbl">Mode</div>
              <p className="af-intake-help">{off
                ? 'Off — no task text leaves the board and nothing is assessed. Your workspace selection is kept.'
                : 'Advisory colours task cards and records every assessment in the activity log.'}</p>
            </div>
            <div className="af-dt-seg" role="group" aria-label="Mode">
              <button aria-pressed={off} onClick={() => setMode('off')}>Off</button>
              <button aria-pressed={!off} onClick={() => setMode('advisory')}>Advisory</button>
            </div>
          </div>

          <div className={'af-intake-ws' + (off ? ' dim' : '')}>
            <div className="af-intake-wshead">
              <span className="lbl">Workspaces</span>
              <span className="af-intake-count"><b>{settings.workspaces.length}</b> of {workspaces.length} opted in</span>
            </div>
            <p className="af-intake-help">Task text is sent to the assessment provider only for the workspaces you opt in here.</p>
            <div className="af-intake-tools">
              <input type="search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter workspaces…" aria-label="Filter workspaces" />
              <button className="af-intake-link" onClick={() => setWorkspaces(workspaces.map((w) => w.name))}>Select all</button>
              <button className="af-intake-link" onClick={() => setWorkspaces([])}>Clear</button>
            </div>
            <div className="af-intake-grid">
              {shown.map((name) => {
                const checked = settings.workspaces.includes(name);
                return (
                  <label key={name} className={'af-intake-opt' + (checked ? ' sel' : '')} title={name}>
                    <input
                      type="checkbox"
                      aria-label={name}
                      checked={checked}
                      onChange={(e) => setWorkspaces(e.target.checked ? [...settings.workspaces, name] : settings.workspaces.filter((x) => x !== name))}
                    />
                    <span className="box" aria-hidden="true">✓</span>
                    <span className="nm">{name}</span>
                  </label>
                );
              })}
              {shown.length === 0 && <div className="af-intake-none">No workspace matches “{filter}”.</div>}
            </div>
          </div>

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Send workspace policy</div>
              <p className="af-intake-help">Include each workspace's engineering policy text with the task, so the assessment can judge it against your standards.</p>
            </div>
            <button
              className="af-intake-switch"
              role="switch"
              aria-checked={settings.sendWorkspacePolicy}
              aria-label="Send workspace policy"
              onClick={() => setSettings({ ...settings, sendWorkspacePolicy: !settings.sendWorkspacePolicy })}
            />
          </div>
        </div>

        <div className="af-intake-foot">
          {error && <span className="af-err">{error}</span>}
          {!error && dirty && <span className="af-intake-dirty">Unsaved changes</span>}
          <span className="sp" />
          <button className="af-mini" onClick={onClose}>Cancel</button>
          <button
            className="af-btn-primary"
            disabled={!dirty}
            onClick={() => api.setIntakeSettings(settings).then(() => { onSaved(); onClose(); }).catch((e: Error) => setError(e.message))}
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
