import { useState } from 'react';
import type { CiMode, DiagnosticStatus, EffectiveWorkspaceProfile, Workspace, WorkspaceDiagnosis } from '../types.js';
import { api } from '../api.js';

/** The editable form of the repository profile: required checks as comma-separated text, '' = unset. */
export interface ProfileDraft { baseBranch: string; requiredChecks: string; ciMode: CiMode | '' }

export function toProfileDraft(w: Workspace): ProfileDraft {
  return { baseBranch: w.baseBranch ?? '', requiredChecks: (w.requiredChecks ?? []).join(', '), ciMode: w.ciMode ?? '' };
}

const checkList = (s: string): string[] => s.split(',').map((x) => x.trim()).filter(Boolean);

/** The PATCH fields for the profile values the user changed (only those); '' / [] clears to null. */
export function profilePatch(initial: ProfileDraft, d: ProfileDraft): { baseBranch?: string | null; requiredChecks?: string[] | null; ciMode?: CiMode | null } {
  const out: { baseBranch?: string | null; requiredChecks?: string[] | null; ciMode?: CiMode | null } = {};
  if (d.baseBranch.trim() !== initial.baseBranch) out.baseBranch = d.baseBranch.trim() || null;
  const checks = checkList(d.requiredChecks);
  if (checks.join('\n') !== checkList(initial.requiredChecks).join('\n')) out.requiredChecks = checks.length > 0 ? checks : null;
  if (d.ciMode !== initial.ciMode) out.ciMode = d.ciMode || null;
  return out;
}

const labelStyle = { fontSize: '12px', color: 'var(--ink-3)' } as const;
const inputStyle = { padding: '6px 10px', minWidth: 0 } as const;
const grid = { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: '8px 10px' } as const;
const effStyle = { fontSize: '11px', color: 'var(--ink-3)' } as const;

const STATUS_ICON: Record<DiagnosticStatus, { icon: string; color: string; title: string }> = {
  ok: { icon: '✓', color: 'var(--ok, #16a34a)', title: 'ok' },
  failed: { icon: '✕', color: 'var(--danger, #dc2626)', title: 'failed' },
  not_applicable: { icon: '–', color: 'var(--ink-3)', title: 'not applicable' },
};

function Effective({ field, profile }: { field: keyof EffectiveWorkspaceProfile; profile: EffectiveWorkspaceProfile | undefined }) {
  if (!profile) return null;
  const e = profile[field];
  const value = field === 'requiredChecks'
    ? ((e.value as string[]).length > 0 ? (e.value as string[]).join(', ') : 'none')
    : e.value === null ? 'unresolved' : String(e.value);
  const source = e.source === 'unresolved' ? 'could not detect the default branch' : e.source;
  return <span data-testid={`effective-${field}`} style={effStyle}>Effective: <span className="mono">{value}</span> ({source})</span>;
}

/** Repository delivery profile (base branch, required checks, CI mode) with each value's effective
 *  value and source, plus a read-only "Diagnose" of the workspace's setup. */
export function RepoProfileSection({ workspace, draft, onChange }: { workspace: Workspace; draft: ProfileDraft; onChange: (d: ProfileDraft) => void }) {
  const [diagnosis, setDiagnosis] = useState<WorkspaceDiagnosis | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof ProfileDraft>(k: K, v: ProfileDraft[K]) => onChange({ ...draft, [k]: v });
  const profile = workspace.profile;

  const runDiagnose = () => {
    setRunning(true);
    setErr(null);
    api.diagnoseWorkspace(workspace.name)
      .then(setDiagnosis)
      .catch((e: Error) => { setDiagnosis(null); setErr(e.message); })
      .finally(() => setRunning(false));
  };

  return (
    <details data-testid="repo-profile" style={{ marginTop: '2px' }} open>
      <summary style={{ fontSize: '12px', color: 'var(--ink-3)', cursor: 'pointer' }}>Repository profile — blank uses the detected / default value</summary>
      <div style={{ ...grid, marginTop: '6px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <label htmlFor={`ws-${workspace.id}-base`} style={labelStyle}>Base branch</label>
          <input id={`ws-${workspace.id}-base`} type="text" className="mono" value={draft.baseBranch} onChange={(e) => set('baseBranch', e.target.value)}
            placeholder="(detect the default branch)" style={inputStyle} />
          <Effective field="baseBranch" profile={profile} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <label htmlFor={`ws-${workspace.id}-checks`} style={labelStyle}>Required checks</label>
          <input id={`ws-${workspace.id}-checks`} type="text" value={draft.requiredChecks} onChange={(e) => set('requiredChecks', e.target.value)}
            placeholder="e.g. build, test" style={inputStyle} />
          <Effective field="requiredChecks" profile={profile} />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
          <label htmlFor={`ws-${workspace.id}-ci`} style={labelStyle}>CI mode</label>
          <select id={`ws-${workspace.id}-ci`} value={draft.ciMode} onChange={(e) => set('ciMode', e.target.value as CiMode | '')} style={inputStyle}>
            <option value="">(default: legacy)</option>
            <option value="legacy">legacy — any red check bounces</option>
            <option value="required">required — only required checks gate</option>
            <option value="none">none — ignore CI</option>
          </select>
          <Effective field="ciMode" profile={profile} />
        </div>
      </div>
      <div style={{ marginTop: '8px', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <div>
          <button className="af-mini" onClick={runDiagnose} disabled={running} title="Read-only check of the repo path, origin, base branch, tools, verify command and credentials">
            {running ? 'Diagnosing…' : 'Diagnose'}
          </button>
        </div>
        {err && <div className="af-err">{err}</div>}
        {diagnosis && (
          <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {diagnosis.checks.map((c) => {
              const s = STATUS_ICON[c.status];
              return (
                <li key={c.id} data-testid="diagnostic-row" data-status={c.status} style={{ fontSize: '12px', display: 'flex', gap: '6px' }}>
                  <span title={s.title} aria-label={s.title} style={{ color: s.color, width: '12px', flex: '0 0 auto' }}>{s.icon}</span>
                  <span style={{ fontWeight: 600, flex: '0 0 auto' }}>{c.label}</span>
                  <span style={{ color: 'var(--ink-3)' }}>
                    {c.reason}{c.detail ? <> — <span className="mono">{c.detail}</span></> : null}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </details>
  );
}
