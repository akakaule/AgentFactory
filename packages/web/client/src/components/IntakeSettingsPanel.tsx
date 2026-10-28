import { useEffect, useMemo, useState } from 'react';
import type { IntakeSettings, Workspace } from '../types.js';
import { api } from '../api.js';

// every field counts as an edit; workspace order doesn't
const comparable = (s: IntakeSettings) => JSON.stringify({ ...s, workspaces: [...s.workspaces].sort() });

const QUEUE_GATE_HELP: Record<IntakeSettings['queueGate'], string> = {
  block: "A flagged task can't be queued until it is edited and re-assessed without flags.",
  acknowledge: 'Queueing a flagged task asks you to acknowledge its flags first.',
  off: 'Flags are advisory only; any task can be queued.',
};

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
  const dirty = comparable(settings) !== comparable(saved);
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
            <p>Scores each task's readiness, complexity and risk before an agent claims it. Optionally it keeps flagged tasks out of the queue and skips the spec for simple tasks.</p>
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

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Skip spec for simple tasks</div>
              <p className="af-intake-help">A queued task assessed as simple goes straight to implementation, and the worker writes its acceptance criteria. Spec-stage tasks wait for the assessment (up to {settings.maxHoldMinutes} min) before a worker starts.</p>
            </div>
            <button
              className="af-intake-switch"
              role="switch"
              aria-checked={settings.skipSpec}
              aria-label="Skip spec for simple tasks"
              onClick={() => setSettings({ ...settings, skipSpec: !settings.skipSpec })}
            />
          </div>
          {settings.skipSpec && (
            <div className={'af-intake-simple' + (off ? ' dim' : '')} role="group" aria-label="Simple means at most">
              <span className="lbl">Simple means</span>
              <div className="af-dt-seg" role="group" aria-label="Highest complexity">
                <button aria-pressed={settings.skipSpecMaxComplexity === 'trivial'} onClick={() => setSettings({ ...settings, skipSpecMaxComplexity: 'trivial' })}>Trivial</button>
                <button aria-pressed={settings.skipSpecMaxComplexity === 'small'} onClick={() => setSettings({ ...settings, skipSpecMaxComplexity: 'small' })}>Up to small</button>
              </div>
              <label>
                risk at most
                <select aria-label="Highest risk" value={settings.skipSpecMaxRisk} onChange={(e) => setSettings({ ...settings, skipSpecMaxRisk: e.target.value as IntakeSettings['skipSpecMaxRisk'] })}>
                  <option value="low">low</option>
                  <option value="medium">medium</option>
                  <option value="high">high</option>
                </select>
              </label>
              <label>
                ready at least
                <input
                  type="number" min={0} max={100} step={5} aria-label="Minimum readiness %"
                  value={Math.round(settings.skipSpecMinReadiness * 100)}
                  onChange={(e) => setSettings({ ...settings, skipSpecMinReadiness: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })}
                />
                %
              </label>
            </div>
          )}

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Queueing flagged tasks</div>
              <p className="af-intake-help">{QUEUE_GATE_HELP[settings.queueGate]}</p>
            </div>
            <div className="af-dt-seg" role="group" aria-label="Queueing flagged tasks">
              <button aria-pressed={settings.queueGate === 'off'} onClick={() => setSettings({ ...settings, queueGate: 'off' })}>Allow</button>
              <button aria-pressed={settings.queueGate === 'acknowledge'} onClick={() => setSettings({ ...settings, queueGate: 'acknowledge' })}>Acknowledge</button>
              <button aria-pressed={settings.queueGate === 'block'} onClick={() => setSettings({ ...settings, queueGate: 'block' })}>Block</button>
            </div>
          </div>

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Require a current assessment to queue</div>
              <p className="af-intake-help">Also refuse tasks Task Intelligence hasn't assessed yet, must re-assess after an edit, or couldn't assess. Imported work items then wait in Backlog.</p>
            </div>
            <button
              className="af-intake-switch"
              role="switch"
              aria-checked={settings.queueRequiresAssessment}
              aria-label="Require a current assessment to queue"
              onClick={() => setSettings({ ...settings, queueRequiresAssessment: !settings.queueRequiresAssessment })}
            />
          </div>

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Flag low readiness</div>
              <p className="af-intake-help">Flag a task whose readiness (the weakest of outcome, scope and verifiability) is below the threshold.</p>
            </div>
            <button
              className="af-intake-switch"
              role="switch"
              aria-checked={settings.readinessNeedsAttention}
              aria-label="Flag low readiness"
              onClick={() => setSettings({ ...settings, readinessNeedsAttention: !settings.readinessNeedsAttention })}
            />
          </div>
          {settings.readinessNeedsAttention && (
            <div className={'af-intake-simple' + (off ? ' dim' : '')}>
              <label>
                readiness below
                <input
                  type="number" min={0} max={100} step={5} aria-label="Flag readiness below %"
                  value={Math.round(settings.readinessThreshold * 100)}
                  onChange={(e) => setSettings({ ...settings, readinessThreshold: Math.min(100, Math.max(0, Number(e.target.value) || 0)) / 100 })}
                />
                %
              </label>
            </div>
          )}

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Flag architectural work</div>
              <p className="af-intake-help">Flag implementation work rated architectural; it needs a reviewed spec first.</p>
            </div>
            <button
              className="af-intake-switch"
              role="switch"
              aria-checked={settings.architecturalNeedsAttention}
              aria-label="Flag architectural work"
              onClick={() => setSettings({ ...settings, architecturalNeedsAttention: !settings.architecturalNeedsAttention })}
            />
          </div>

          <div className={'af-intake-row' + (off ? ' dim' : '')}>
            <div className="txt">
              <div className="lbl">Flag risk</div>
              <p className="af-intake-help">Flag a task whose impact if wrong is rated at or above this level.</p>
            </div>
            <select
              aria-label="Flag risk at or above"
              value={settings.riskAttentionLevel ?? ''}
              onChange={(e) => setSettings({ ...settings, riskAttentionLevel: (e.target.value || null) as IntakeSettings['riskAttentionLevel'] })}
            >
              <option value="">never</option>
              <option value="low">low or higher</option>
              <option value="medium">medium or higher</option>
              <option value="high">high or higher</option>
              <option value="critical">critical</option>
            </select>
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
