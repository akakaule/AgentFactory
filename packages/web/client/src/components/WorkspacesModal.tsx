import { useState } from 'react';
import type { Workspace } from '../types.js';
import { api } from '../api.js';
import { wsColor } from '../wsColor.js';

interface Props {
  workspaces: Workspace[];
  onCreated: () => void;
  onClose: () => void;
}

/** One workspace row with inline editing of its repo path, engineering-discipline fields, and PAT. */
function WorkspaceItem({ workspace, dot, onSaved }: { workspace: Workspace; dot: string; onSaved: () => void }) {
  const [repoPath, setRepoPath] = useState(workspace.repoPath);
  const [policy, setPolicy] = useState(workspace.policy ?? '');
  const [verifyCommand, setVerifyCommand] = useState(workspace.verifyCommand ?? '');
  // The PAT is write-only: we never receive its value, only workspace.hasPat. An empty input means
  // "leave it unchanged"; a typed value replaces it. Clearing is a separate explicit action.
  const [pat, setPat] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty =
    repoPath !== workspace.repoPath ||
    policy !== (workspace.policy ?? '') ||
    verifyCommand !== (workspace.verifyCommand ?? '') ||
    pat.trim() !== '';

  const handleSave = () => {
    setSaving(true);
    setErr(null);
    // empty string clears policy/verifyCommand (server normalises whitespace-only to null); the PAT
    // is only sent when the user typed a new one — omitted, it stays untouched (never accidentally cleared).
    // repoPath is a defining field: sent only when non-empty (it can never be blanked).
    const body: { repoPath?: string; policy: string; verifyCommand: string; pat?: string } = { policy, verifyCommand };
    if (repoPath.trim() !== '') body.repoPath = repoPath.trim();
    if (pat.trim() !== '') body.pat = pat.trim();
    api.updateWorkspace(workspace.name, body)
      .then(() => { setPat(''); onSaved(); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  const handleClearPat = () => {
    setSaving(true);
    setErr(null);
    api.updateWorkspace(workspace.name, { pat: null })
      .then(() => { setPat(''); onSaved(); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span className="af-ws-dot" style={{ background: dot }}></span>
        <span style={{ fontWeight: 600, minWidth: '120px' }}>{workspace.name}</span>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px', paddingLeft: '22px' }}>
        <label style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Repo path (absolute path to the workspace's git repo)</label>
        <input
          type="text"
          value={repoPath}
          onChange={(e) => setRepoPath(e.target.value)}
          placeholder="/absolute/path/to/repo"
          className="mono"
          style={{ padding: '6px 10px' }}
        />
        <label style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Engineering policy (injected into every agent + reviewer)</label>
        <textarea
          value={policy}
          onChange={(e) => setPolicy(e.target.value)}
          placeholder="e.g. All new code is TDD. Public APIs need doc comments. No new deps without a note."
          rows={3}
          style={{ padding: '6px 10px', resize: 'vertical', fontFamily: 'inherit' }}
        />
        <label style={{ fontSize: '12px', color: 'var(--ink-3)' }}>Verify command (must pass before submit on the implementation stage)</label>
        <input
          type="text"
          value={verifyCommand}
          onChange={(e) => setVerifyCommand(e.target.value)}
          placeholder="e.g. npm test && npm run build"
          style={{ padding: '6px 10px' }}
        />
        <label style={{ fontSize: '12px', color: 'var(--ink-3)' }}>
          Git PAT (used for push/verify; falls back to env if unset) —{' '}
          <span style={{ color: workspace.hasPat ? 'var(--ok, #16a34a)' : 'var(--ink-3)' }}>
            {workspace.hasPat ? 'set ✓' : 'not set'}
          </span>
        </label>
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="password"
            value={pat}
            onChange={(e) => setPat(e.target.value)}
            placeholder={workspace.hasPat ? 'Enter a new PAT to replace the stored one' : 'Paste a personal access token'}
            autoComplete="off"
            style={{ flex: 1, padding: '6px 10px' }}
          />
          {workspace.hasPat && (
            <button className="af-mini danger" onClick={handleClearPat} disabled={saving} title="Remove the stored PAT (fall back to env vars)">
              Clear
            </button>
          )}
        </div>
        {err && <div className="af-err">{err}</div>}
        <div>
          <button className="af-btn-primary" onClick={handleSave} disabled={!dirty || saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  );
}

export function WorkspacesModal({ workspaces, onCreated, onClose }: Props) {
  const [name, setName] = useState('');
  const [repoPath, setRepoPath] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleCreate = () => {
    const n = name.trim();
    const p = repoPath.trim();
    if (!n || !p) {
      setError('Name and repo path are required.');
      return;
    }
    api.createWorkspace({ name: n, repoPath: p })
      .then(() => {
        setName('');
        setRepoPath('');
        setError(null);
        onCreated();
      })
      .catch((e: Error) => setError(e.message));
  };

  return (
    <div className="af-overlay">
      <div className="af-modal" style={{ padding: '16px' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Workspaces</h3>
          <button className="af-x" onClick={onClose}>✕</button>
        </div>

        <div style={{ margin: '12px 0' }}>
          {workspaces.map((w) => (
            <WorkspaceItem key={w.id} workspace={w} dot={wsColor(workspaces, w.name)} onSaved={onCreated} />
          ))}
        </div>

        {error && <div className="af-err" style={{ marginBottom: '8px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="workspace-slug"
            style={{ flex: '0 0 160px', padding: '6px 10px' }}
          />
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="Absolute repo path"
            style={{ flex: 1, padding: '6px 10px' }}
          />
          <button className="af-btn-primary" onClick={handleCreate}>
            Create workspace
          </button>
        </div>
      </div>
    </div>
  );
}
