import { useState, type ClipboardEvent } from 'react';
import type { Task, Attachment, Stage } from '../types.js';
import { attachmentUrl } from '../api.js';
import { downscalePastedImage } from '../image.js';

interface FormFields {
  title: string;
  spec: string;
  acceptanceCriteria?: string; // omitted when the description stage writes them
  stage?: Stage;
  workspace?: string;
}

export interface PendingImage { filename: string; mime: string; dataBase64: string; }

interface Props {
  mode: 'create' | 'edit';
  initial?: Pick<Task, 'title' | 'spec' | 'acceptanceCriteria'> & { attachments?: Attachment[] };
  onSubmit: (fields: FormFields, images: PendingImage[], removedIds: number[]) => void | Promise<void>;
  onCancel?: () => void;
  workspaces?: string[];
  initialWorkspace?: string;
}

export function TaskForm({ mode, initial, onSubmit, onCancel, workspaces, initialWorkspace }: Props) {
  const [title, setTitle] = useState(initial?.title ?? '');
  const [spec, setSpec] = useState(initial?.spec ?? '');
  const [acceptanceCriteria, setAcceptanceCriteria] = useState(initial?.acceptanceCriteria ?? '');
  const [workspace, setWorkspace] = useState(initialWorkspace ?? workspaces?.[0] ?? 'default');
  // full pipeline by default: an agent writes the description + plan before any code
  const [stage, setStage] = useState<Stage>('description');
  const [images, setImages] = useState<PendingImage[]>([]);
  const [removedIds, setRemovedIds] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const showWorkspacePicker = (workspaces?.length ?? 0) > 1;
  const pipeline = mode === 'create' && stage === 'description'; // AC optional — that stage writes them
  const existing = (initial?.attachments ?? []).filter((a) => !removedIds.includes(a.id));

  const handlePaste = (e: ClipboardEvent) => {
    const files = Array.from(e.clipboardData?.items ?? [])
      .filter((i) => i.type.startsWith('image/'))
      .map((i) => i.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length === 0) return; // plain text pastes flow through untouched
    e.preventDefault();
    for (const f of files) {
      downscalePastedImage(f)
        .then((img) => {
          setImages((arr) => [...arr, { filename: f.name || 'pasted.png', ...img }]);
          setError(null);
        })
        .catch((err: Error) => setError(err.message));
    }
  };

  const handleSubmit = async () => {
    if (submitting) return;
    const t = title.trim();
    const s = spec.trim();
    const ac = acceptanceCriteria.trim();
    if (!t || !s || (!ac && !pipeline)) {
      setError(pipeline ? 'Title and spec are required.' : 'All fields are required.');
      return;
    }
    setError(null);
    const fields: FormFields = { title: t, spec: s };
    if (ac) fields.acceptanceCriteria = ac;
    if (mode === 'create') fields.stage = stage;
    if (showWorkspacePicker) fields.workspace = workspace;
    try {
      setSubmitting(true);
      // A rejection here (network/validation/server error) used to vanish silently, leaving a
      // dead button. Surface it instead — on success the parent closes (unmounts) this form.
      await onSubmit(fields, images, removedIds);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Could not save — the server rejected the request or is unreachable.');
      setSubmitting(false);
    }
  };

  return (
    <div style={{ padding: '16px' }} onPaste={handlePaste}>
      <h3 style={{ marginTop: 0 }}>{mode === 'create' ? 'New Task' : 'Edit Task'}</h3>
      {error && <div className="af-err" style={{ marginBottom: '8px' }}>{error}</div>}
      {mode === 'create' && (
        <div style={{ marginBottom: '12px' }}>
          <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>Workflow</label>
          <select
            aria-label="Workflow"
            value={stage}
            onChange={(e) => setStage(e.target.value as Stage)}
            style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px' }}
          >
            <option value="description">Full pipeline — describe → plan → implement</option>
            <option value="implementation">Implementation only — skip the doc stages</option>
          </select>
        </div>
      )}
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
        {(existing.length > 0 || images.length > 0) && (
          <div className="af-atts">
            {existing.map((a) => (
              <span className="af-att" key={`e${a.id}`}>
                <img src={attachmentUrl(a.id)} alt={a.filename} />
                <button className="rm" aria-label={`Remove ${a.filename}`} onClick={() => setRemovedIds((ids) => [...ids, a.id])}>✕</button>
              </span>
            ))}
            {images.map((img, i) => (
              <span className="af-att" key={`p${i}`}>
                <img src={`data:${img.mime};base64,${img.dataBase64}`} alt={img.filename} />
                <button className="rm" aria-label={`Remove ${img.filename}`} onClick={() => setImages((arr) => arr.filter((_, j) => j !== i))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <div className="af-paste-hint">Paste images to attach — they reach the agent with the spec.</div>
      </div>
      <div style={{ marginBottom: '12px' }}>
        <label style={{ display: 'block', marginBottom: '4px', fontWeight: 600 }}>
          Acceptance Criteria{pipeline ? ' (optional)' : ''}
        </label>
        <textarea
          value={acceptanceCriteria}
          onChange={(e) => setAcceptanceCriteria(e.target.value)}
          rows={3}
          style={{ width: '100%', boxSizing: 'border-box', padding: '6px 8px', resize: 'vertical' }}
          placeholder={pipeline ? 'Optional — the description stage writes these…' : 'Define done…'}
        />
      </div>
      <div style={{ display: 'flex', gap: '8px' }}>
        <button className="af-btn-primary" onClick={handleSubmit} disabled={submitting}>
          {submitting ? (mode === 'create' ? 'Creating…' : 'Saving…') : (mode === 'create' ? 'Create' : 'Save')}
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
