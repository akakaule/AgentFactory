import { useState, useCallback, useEffect } from 'react';
import type { TaskDetail } from '../types.js';
import { api } from '../api.js';
import { timeAgo } from '../time.js';
import { useEventStream } from '../useEventStream.js';
import { StatusBadge } from './StatusBadge.js';
import { CommentBox } from './CommentBox.js';
import { ReviewActions } from './ReviewActions.js';
import { TaskForm } from './TaskForm.js';

interface Props {
  taskKey: string;
  onClose: () => void;
  onChanged: () => void;
}

export function DetailPanel({ taskKey, onClose, onChanged }: Props) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const refetch = useCallback(() => {
    api.getTask(taskKey)
      .then((t) => { setTask(t); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [taskKey]);

  useEffect(() => {
    setTask(null);
    setEditing(false);
    refetch();
  }, [refetch]);

  useEventStream(refetch);

  const afterMutation = () => {
    refetch();
    onChanged();
  };

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        width: '480px',
        height: '100vh',
        backgroundColor: '#fff',
        boxShadow: '-4px 0 16px rgba(0,0,0,0.15)',
        overflowY: 'auto',
        zIndex: 100,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '12px 16px',
          borderBottom: '1px solid #e0e0e0',
          position: 'sticky',
          top: 0,
          backgroundColor: '#fff',
          zIndex: 1,
        }}
      >
        <span style={{ fontFamily: 'monospace', color: '#666' }}>{taskKey}</span>
        <button onClick={onClose} style={{ border: 'none', background: 'none', fontSize: '1.2rem', cursor: 'pointer' }}>
          ✕
        </button>
      </div>

      {/* Content */}
      <div style={{ padding: '16px', flex: 1 }}>
        {error && <div style={{ color: '#e5534b' }}>{error}</div>}
        {!task && !error && <div style={{ color: '#999' }}>Loading…</div>}
        {task && (
          <>
            {/* Title & Status */}
            <div style={{ marginBottom: '12px' }}>
              <h2 style={{ margin: '0 0 8px 0' }}>{task.title}</h2>
              <StatusBadge status={task.status} />
              <div style={{ marginTop: '8px', fontSize: '0.85rem', color: '#666' }}>
                <span style={{ backgroundColor: '#eef1f6', borderRadius: '10px', padding: '2px 8px' }}>
                  {task.workspace}
                </span>
                <code style={{ marginLeft: '8px' }}>{task.repoPath}</code>
              </div>
            </div>

            {/* Spec */}
            <section style={{ marginBottom: '12px' }}>
              <h4 style={{ margin: '0 0 4px 0' }}>Spec</h4>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.spec}</p>
            </section>

            {/* Acceptance Criteria */}
            <section style={{ marginBottom: '12px' }}>
              <h4 style={{ margin: '0 0 4px 0' }}>Acceptance Criteria</h4>
              <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.acceptanceCriteria}</p>
            </section>

            {/* Result Summary */}
            {task.resultSummary && (
              <section style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 4px 0' }}>Result Summary</h4>
                <p style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{task.resultSummary}</p>
              </section>
            )}

            {/* Links */}
            {task.links.length > 0 && (
              <section style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 4px 0' }}>Links</h4>
                <ul style={{ margin: 0, paddingLeft: '20px' }}>
                  {task.links.map((link) => (
                    <li key={link.id}>
                      <a href={link.url} target="_blank" rel="noreferrer">
                        {link.label}
                      </a>
                      <span style={{ color: '#999', fontSize: '0.8rem', marginLeft: '6px' }}>
                        [{link.kind}]
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {/* Activity */}
            {task.activity.length > 0 && (
              <section style={{ marginBottom: '12px' }}>
                <h4 style={{ margin: '0 0 4px 0' }}>Activity</h4>
                <div style={{ borderLeft: '3px solid #e0e0e0', paddingLeft: '12px' }}>
                  {task.activity.map((entry) => (
                    <div key={entry.id} style={{ marginBottom: '8px' }}>
                      <div style={{ fontSize: '0.8rem', color: '#666' }}>
                        <strong>{entry.actor}</strong> · {entry.type}
                        {entry.fromStatus && entry.toStatus && (
                          <span> · {entry.fromStatus} → {entry.toStatus}</span>
                        )}
                      </div>
                      {entry.body && (
                        <p style={{ margin: '2px 0 0 0', whiteSpace: 'pre-wrap', fontSize: '0.9rem' }}>
                          {entry.body}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            )}

            {/* Backlog actions */}
            {task.status === 'backlog' && (
              <section style={{ marginBottom: '12px', borderTop: '1px solid #e0e0e0', paddingTop: '12px' }}>
                <button
                  onClick={() =>
                    api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})
                  }
                  style={{ marginBottom: '8px', padding: '6px 14px' }}
                >
                  Release to Queued
                </button>
                {editing ? (
                  <TaskForm
                    mode="edit"
                    initial={task}
                    onSubmit={(fields) =>
                      api.updateTask(task.key, fields).then(() => { setEditing(false); afterMutation(); }).catch(() => {})
                    }
                    onCancel={() => setEditing(false)}
                  />
                ) : (
                  <button onClick={() => setEditing(true)} style={{ marginLeft: '8px', padding: '6px 14px' }}>
                    Edit
                  </button>
                )}
              </section>
            )}

            {/* In-progress claim + release */}
            {task.status === 'in_progress' && (
              <section style={{ marginBottom: '12px', borderTop: '1px solid #e0e0e0', paddingTop: '12px' }}>
                <div style={{ fontSize: '0.85rem', color: '#666', marginBottom: '8px' }}>
                  Claimed
                  {task.claimedBy && <> by <strong>{task.claimedBy}</strong></>}
                  {task.claimedAt && <> · {timeAgo(task.claimedAt)}</>}
                </div>
                <button
                  onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                  style={{ padding: '6px 14px' }}
                  title="Worker gone? Re-queue the task; history is preserved for the next claimant."
                >
                  Release claim
                </button>
              </section>
            )}

            {/* In-review actions */}
            {task.status === 'in_review' && (
              <ReviewActions
                onApprove={() => api.approve(task.key).then(afterMutation).catch(() => {})}
                onRequestChanges={(fb) =>
                  api.requestChanges(task.key, fb).then(afterMutation).catch(() => {})
                }
              />
            )}

            {/* Comment box — always */}
            <CommentBox
              onSubmit={(b) => api.addComment(task.key, b).then(afterMutation).catch(() => {})}
            />
          </>
        )}
      </div>
    </div>
  );
}
