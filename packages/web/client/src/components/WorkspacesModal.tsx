import { useState } from 'react';
import type { Workspace } from '../types.js';
import { api } from '../api.js';
import { wsColor } from '../wsColor.js';

interface Props {
  workspaces: Workspace[];
  onCreated: () => void;
  onClose: () => void;
}

/** One workspace row with inline editing of the engineering-discipline fields. */
function WorkspaceItem({ workspace, dot, onSaved }: { workspace: Workspace; dot: string; onSaved: () => void }) {
  const [policy, setPolicy] = useState(workspace.policy ?? '');
  const [verifyCommand, setVerifyCommand] = useState(workspace.verifyCommand ?? '');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dirty = policy !== (workspace.policy ?? '') || verifyCommand !== (workspace.verifyCommand ?? '');

  const handleSave = () => {
    setSaving(true);
    setErr(null);
    // empty string clears the field (server normalises whitespace-only to null)
    api.updateWorkspace(workspace.name, { policy, verifyCommand })
      .then(() => onSaved())
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  return (
    <div style={{ padding: '10px 0', borderBottom: '1px solid var(--line-soft)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
        <span className="af-ws-dot" style={{ background: dot }}></span>
        <span style={{ fontWeight: 600, minWidth: '120px' }}>{workspace.name}</span>
        <code className="mono" style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{workspace.repoPath}</code>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '8px', paddingLeft: '22px' }}>
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
