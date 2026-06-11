import { useState } from 'react';
import type { Workspace } from '../types.js';
import { api } from '../api.js';
import { wsColor } from '../wsColor.js';

interface Props {
  workspaces: Workspace[];
  onCreated: () => void;
  onClose: () => void;
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
            <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--line-soft)' }}>
              <span className="af-ws-dot" style={{ background: wsColor(workspaces, w.name) }}></span>
              <span style={{ fontWeight: 600, minWidth: '120px' }}>{w.name}</span>
              <code className="mono" style={{ color: 'var(--ink-3)', fontSize: '12px' }}>{w.repoPath}</code>
            </div>
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
