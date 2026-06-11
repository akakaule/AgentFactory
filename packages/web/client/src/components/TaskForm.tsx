import { useState } from 'react';
import type { Task } from '../types.js';

interface FormFields {
  title: string;
  spec: string;
  acceptanceCriteria: string;
  workspace?: string;
}

interface Props {
  mode: 'create' | 'edit';
  initial?: Pick<Task, 'title' | 'spec' | 'acceptanceCriteria'>;
  onSubmit: (fields: FormFields) => void;
  onCancel?: () => void;
  workspaces?: string[];
  initialWorkspace?: string;
}

export function TaskForm({ mode, initial, onSubmit, onCancel, workspaces, initialWorkspace }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [spec, setSpec] = useState(initial?.spec ?? '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(initial?.acceptanceCriteria ?? '');
  const [workspace, setWorkspace] = useState(initialWorkspace ?? workspaces?.[0] ?? 'default');
  const [error, setError] = useState<string | null>(null);

  const showWorkspacePicker = mode === 'create' && (workspaces?.length ?? 0) > 1;

  const handleSubmit = () => {
    const t = title.trim();
    const s = spec.trim();
    const ac = acceptanceCriteria.trim();
    if (!t || !s || !ac) {
      setError('All fields are required.');
      return;
    }
    setError(null);
    onSubmit(
      showWorkspacePicker
        ? { title: t, spec: s, acceptanceCriteria: ac, workspace }
        : { title: t, spec: s, acceptanceCriteria: ac },
    );
  };

  return (
    <div style={{ padding: '16px' }}>
      <h3 style={{ marginTop: 0 }}>{mode === 'create' ? 'New Task' : 'Edit Task'}</h3>
      {error && <div className="af-err" style={{ marginBottom: '8px' }}>{error}</div>}
      {showWorkspacePicker && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>Workspace</label>
          <select
            aria-label="Workspace"
            value={workspace}
            onChange={(e) => setWorkspace(e.target.value)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px' }}
          >
            {workspaces!.map((w) => (
              <option key={w} value={w}>{w}</option>
            ))}
          </select>
        </div>
      )}
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>Title</label>
        <input
          type="text"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px' }}
          placeholder="Task title"
        />
      </div>
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>Spec</label>
        <textarea
          value={spec}
          onChange={(e) => setSpec(e.target.value)}
          rows={4}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical' }}
          placeholder="Describe the task…"
        />
      </div>
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>Acceptance Criteria</label>
        <textarea
          value={acceptanceCriteria}
          onChange={(e) => setAcceptanceCriteria(e.target.value)}
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical' }}
          placeholder="Define done…"
        />
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="af-btn-primary" onClick={handleSubmit}>
          {mode === 'create' ? 'Create' : 'Save'}
        </button>
        {onCancel && (
          <button className="af-mini" style={{ height: 34 }} onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>
    </div>
  );
}
