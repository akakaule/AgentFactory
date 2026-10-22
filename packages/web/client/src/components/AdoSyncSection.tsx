import type { AdoSyncSettings, Workspace } from '../types.js';

/** Mirror of core's adoSync defaults (the client imports only types from core; the server is the
 *  validator, so a drift here only changes what an untouched form pre-fills). */
export const ADO_SYNC_DEFAULTS: AdoSyncSettings = {
  enabled: false, workItemTypes: ['User Story'], states: ['New'], areaPath: '', iterationPath: '', requiredTag: '', orderBy: '',
  assignTo: '', claimState: 'Active', reviewState: 'Resolved', closeState: 'Closed', markerTag: 'agentfactory',
  stage: 'description', autoQueue: true, maxDescriptionChars: 8000, maxImportsPerTick: 10,
};

/** The editable form of the settings: lists as comma-separated text, numbers as text. */
export type AdoSyncDraft = Omit<AdoSyncSettings, 'workItemTypes' | 'states' | 'maxDescriptionChars' | 'maxImportsPerTick'> & {
  workItemTypes: string; states: string; maxDescriptionChars: string; maxImportsPerTick: string;
};

export function toDraft(s: AdoSyncSettings | null | undefined): AdoSyncDraft {
  const v = s ?? ADO_SYNC_DEFAULTS;
  return {
    ...v, workItemTypes: v.workItemTypes.join(', '), states: v.states.join(', '),
    maxDescriptionChars: String(v.maxDescriptionChars), maxImportsPerTick: String(v.maxImportsPerTick),
  };
}

const list = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);
const num = (s: string, fallback: number): number => (/^\d+$/.test(s.trim()) ? Number(s.trim()) : fallback);

export function fromDraft(d: AdoSyncDraft): AdoSyncSettings {
  return {
    ...d, workItemTypes: list(d.workItemTypes), states: list(d.states),
    maxDescriptionChars: num(d.maxDescriptionChars, ADO_SYNC_DEFAULTS.maxDescriptionChars),
    maxImportsPerTick: num(d.maxImportsPerTick, ADO_SYNC_DEFAULTS.maxImportsPerTick),
  };
}

type TextKey = Exclude<keyof AdoSyncDraft, 'enabled' | 'autoQueue' | 'stage'>;

const labelStyle = { fontSize: '12px', color: 'var(--ink-3)' } as const;
const inputStyle = { padding: '6px 10px', minWidth: 0 } as const;
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px 10px' } as const;

/**
 * "Azure DevOps work items": which work items the watcher imports into this workspace and how the
 * board state is written back. Shown only when the workspace origin is on Azure DevOps (the org and
 * project come from that origin). Controlled: the parent owns the draft and saves it.
 */
export function AdoSyncSection({ workspace, draft, onChange }: { workspace: Workspace; draft: AdoSyncDraft; onChange: (d: AdoSyncDraft) => void }) {
  const remote = workspace.remote;
  if (remote === undefined) return null; // older payload without origin info
  if (remote?.provider !== 'azdo') {
    return <div style={labelStyle}>Work-item import needs an Azure DevOps origin.</div>;
  }
  const id = (k: string) => `ado-${workspace.name}-${k}`;
  const set = <K extends keyof AdoSyncDraft>(k: K, v: AdoSyncDraft[K]) => onChange({ ...draft, [k]: v });
  const text = (k: TextKey, label: string, placeholder = '') => (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '3px', minWidth: 0 }}>
      <label htmlFor={id(k)} style={labelStyle}>{label}</label>
      <input id={id(k)} type="text" value={draft[k]} placeholder={placeholder} onChange={(e) => set(k, e.target.value)} style={inputStyle} />
    </div>
  );

  return (
    <details open={draft.enabled} style={{ marginTop: '2px' }}>
      <summary style={{ ...labelStyle, cursor: 'pointer' }}>
        Azure DevOps work items · {remote.organization} / {remote.project}{draft.enabled ? ' (importing)' : ''}
      </summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginTop: '8px' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
          <input type="checkbox" checked={draft.enabled} onChange={(e) => set('enabled', e.target.checked)} />
          Import work items from Azure DevOps
        </label>
        <div style={labelStyle}>Which items</div>
        <div style={grid}>
          {text('workItemTypes', 'Work item types', 'User Story, Bug')}
          {text('states', 'New states', 'New')}
          {text('areaPath', 'Area path', 'any')}
          {text('iterationPath', 'Iteration path', 'any')}
          {text('requiredTag', 'Required tag', 'none: import all unassigned')}
          {text('assignTo', 'Assign to', 'PAT owner')}
        </div>
        <div style={labelStyle}>On the board</div>
        <div style={grid}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <label htmlFor={id('stage')} style={labelStyle}>Start stage</label>
            <select id={id('stage')} value={draft.stage} onChange={(e) => set('stage', e.target.value as AdoSyncDraft['stage'])} style={inputStyle}>
              <option value="description">Spec</option>
              <option value="implementation">Implementation</option>
            </select>
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', alignSelf: 'end', paddingBottom: '6px' }}>
            <input type="checkbox" checked={draft.autoQueue} onChange={(e) => set('autoQueue', e.target.checked)} />
            Queue automatically
          </label>
        </div>
        <div style={labelStyle}>Write back to Azure DevOps</div>
        <div style={grid}>
          {text('claimState', 'On claim', 'Active')}
          {text('reviewState', 'In review', 'blank = off')}
          {text('closeState', 'Done (PR merged)', 'Closed')}
        </div>
        <details>
          <summary style={{ ...labelStyle, cursor: 'pointer' }}>Advanced</summary>
          <div style={{ ...grid, marginTop: '6px' }}>
            {text('markerTag', 'Marker tag', 'agentfactory')}
            {text('orderBy', 'Order by', 'backlog order')}
            {text('maxDescriptionChars', 'Description cap (chars)')}
            {text('maxImportsPerTick', 'Imports per poll')}
          </div>
        </details>
        {workspace.adoSyncWiql && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            <div style={labelStyle}>Query the watcher runs (saved settings)</div>
            <pre className="mono" style={{ margin: 0, padding: '8px 10px', fontSize: '11.5px', whiteSpace: 'pre-wrap', wordBreak: 'break-word', background: 'var(--bg-2, rgba(127,127,127,.08))', borderRadius: '6px' }}>{workspace.adoSyncWiql}</pre>
          </div>
        )}
        <div style={labelStyle}>The workspace PAT needs the Code and Work Items (Read &amp; write) scopes.</div>
      </div>
    </details>
  );
}
