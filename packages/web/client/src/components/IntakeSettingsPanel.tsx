import { useEffect, useState } from 'react';
import type { IntakeSettings, Workspace } from '../types.js';
import { api } from '../api.js';

export function IntakeSettingsPanel({ workspaces, onSaved, onClose }: { workspaces: Workspace[]; onSaved: () => void; onClose: () => void }) {
  const [settings, setSettings] = useState<IntakeSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void api.getIntakeSettings().then(setSettings).catch((e: Error) => setError(e.message)); }, []);
  if (!settings) return <div className="af-overlay"><div className="af-modal">{error ?? 'Loading intake settings…'}</div></div>;
  return <div className="af-overlay"><div className="af-modal af-ws-modal">
    <div className="af-modal-head"><h3>Task Intelligence</h3><button className="af-x" onClick={onClose}>✕</button></div>
    <p className="af-intake-muted">Advisory mode colors tasks and records assessments. Workspaces are explicit opt-ins for sending task text.</p>
    <label>Mode<select value={settings.mode} onChange={(e) => setSettings({ ...settings, mode: e.target.value as IntakeSettings['mode'] })}><option value="off">Off</option><option value="advisory">Advisory</option></select></label>
    <fieldset><legend>Opted-in workspaces</legend>{workspaces.map((w) => <label key={w.id}><input type="checkbox" checked={settings.workspaces.includes(w.name)} onChange={(e) => setSettings({ ...settings, workspaces: e.target.checked ? [...settings.workspaces, w.name] : settings.workspaces.filter((x) => x !== w.name) })} /> {w.name}</label>)}</fieldset>
    <label><input type="checkbox" checked={settings.sendWorkspacePolicy} onChange={(e) => setSettings({ ...settings, sendWorkspacePolicy: e.target.checked })} /> Send workspace policy</label>
    {error && <div className="af-err">{error}</div>}
    <button className="af-btn-primary" onClick={() => api.setIntakeSettings(settings).then(() => { onSaved(); onClose(); }).catch((e: Error) => setError(e.message))}>Save</button>
  </div></div>;
}
