import { useState } from 'react';
import type { Workspace } from '../types.js';
import { api } from '../api.js';

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
    <div
      style={{
        position: 'fixed',
        inset: 0,
        backgroundColor: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 200,
      }}
    >
      <div
        style={{
          backgroundColor: '#fff',
          borderRadius: '8px',
          width: '520px',
          maxWidth: '95vw',
          maxHeight: '90vh',
          overflowY: 'auto',
          padding: '16px',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <h3 style={{ margin: 0 }}>Workspaces</h3>
          <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>
            ✕
          </button>
        </div>

        <div style={{ margin: '12px 0' }}>
          {workspaces.map((w) => (
            <div key={w.id} style={{ display: 'flex', gap: '8px', padding: '6px 0', borderBottom: '1px solid #eee' }}>
              <span style={{ fontWeight: 600, minWidth: '120px' }}>{w.name}</span>
              <code style={{ color: '#666' }}>{w.repoPath}</code>
            </div>
          ))}
        </div>

        {error && <div style={{ color: '#e5534b', marginBottom: '8px' }}>{error}</div>}
        <div style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="workspace-slug"
            style={{ flex: '0 0 160px', padding: '6px 8px' }}
          />
          <input
            type="text"
            value={repoPath}
            onChange={(e) => setRepoPath(e.target.value)}
            placeholder="Absolute repo path"
            style={{ flex: 1, padding: '6px 8px' }}
          />
          <button onClick={handleCreate} style={{ padding: '6px 14px' }}>
            Create workspace
          </button>
        </div>
      </div>
    </div>
  );
}
