import { useState, useCallback, useEffect, type ReactElement } from 'react';
import type { TaskDetail, Activity, LinkKind } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS } from '../status.js';
import { api } from '../api.js';
import { timeAgo, shortTime } from '../time.js';
import { useEventStream } from '../useEventStream.js';
import { CommentBox } from './CommentBox.js';
import { ReviewActions } from './ReviewActions.js';
import { TaskForm } from './TaskForm.js';
import { Changes } from './Changes.js';
import { TaskMetrics } from './TaskMetrics.js';
import { I } from '../icons.js';

interface Props {
  taskKey: string;
  onClose: () => void;
  onChanged: () => void;
}

const LINK_ICON: Record<LinkKind, (p: object) => ReactElement> = {
  branch: I.branch, pr: I.link, worktree: I.folder, log: I.link, url: I.link,
};

function ActivityItem({ entry }: { entry: Activity }) {
  const who = entry.actor === 'agent' ? 'agent' : 'you';
  return (
    <div className="af-tl-i">
      <span className={'af-tl-dot ' + entry.actor}>{entry.actor === 'agent' ? I.bot({}) : I.person({})}</span>
      <div className="af-tl-main">
        <div className="af-tl-line">
          <span className={'who ' + entry.actor}>{who}</span> <span className="kind">· {entry.type}</span>
          {entry.fromStatus && entry.toStatus && (
            <span className="mv"> · {STATUS_LABELS[entry.fromStatus]} → {STATUS_LABELS[entry.toStatus]}</span>
          )}
        </div>
        {entry.body && <div className="af-tl-text">{entry.body}</div>}
      </div>
      <span className="af-tl-time">{shortTime(entry.createdAt)}</span>
    </div>
  );
}

export function DetailPanel({ taskKey, onClose, onChanged }: Props) {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const refetch = useCallback(() => {
    api.getTask(taskKey)
      .then((t) => { setTask(t); setError(null); })
      .catch((e: Error) => setError(e.message));
  }, [taskKey]);

  useEffect(() => {
    setTask(null);
    setEditing(false);
    setConfirmingDelete(false);
    refetch();
  }, [refetch]);

  useEventStream(refetch);

  const afterMutation = () => {
    refetch();
    onChanged();
  };

  const hue = task ? STATUS_COLORS[task.status] : 'var(--ink-2)';
  const branchLink = task?.links.filter((l) => l.kind === 'branch').at(-1);

  return (
    <>
      <div className="af-scrim" onClick={onClose}></div>
      <aside className="af-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="af-drawer-head">
          <span className="af-key">{taskKey}</span>
          {task && <span className="af-wsbadge">{task.workspace}</span>}
          <button className="af-x" onClick={onClose}>✕</button>
        </div>
        <div className="af-drawer-body">
          {error && <div style={{ color: 'var(--st-blocked)' }}>{error}</div>}
          {!task && !error && <div style={{ color: 'var(--ink-3)' }}>Loading…</div>}
          {task && (
            <>
              <span className="af-pill" style={{ color: hue, background: `color-mix(in srgb, ${hue} 16%, transparent)` }}>
                <span className="d" style={{ background: hue }}></span>{STATUS_LABELS[task.status]}
              </span>
              <h2 className="af-d-title">{task.title}</h2>

              <div className="af-d-tags">
                {task.status === 'backlog' && (<>
                  <button
                    className="af-mini go"
                    onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                  >
                    Queue task
                  </button>
                  {!editing && <button className="af-mini" onClick={() => setEditing(true)}>Edit</button>}
                </>)}
                {task.status === 'blocked' && (
                  <button
                    className="af-mini"
                    onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                  >
                    Unblock → Queued
                  </button>
                )}
                {task.status === 'in_progress' && (<>
                  <span className="af-claimline">
                    Claimed{task.claimedBy && <> by <strong>{task.claimedBy}</strong></>}{task.claimedAt && <> · {timeAgo(task.claimedAt)}</>}
                  </span>
                  <button
                    className="af-mini"
                    onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                    title="Worker gone? Re-queue the task; history is preserved for the next claimant."
                  >
                    Release claim
                  </button>
                </>)}
                {task.status === 'done' && (
                  <button
                    className="af-mini"
                    onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                    title="PR build failed? Comment the failure first, then reopen — the next claimant gets the full history and pushes to the same branch/PR."
                  >
                    Reopen
                  </button>
                )}
              </div>

              {task.status === 'in_review' && (
                <ReviewActions
                  onApprove={() => api.approve(task.key).then(afterMutation).catch(() => {})}
                  onRequestChanges={(fb) => api.requestChanges(task.key, fb).then(afterMutation).catch(() => {})}
                />
              )}

              {editing && task.status === 'backlog' && (
                <TaskForm
                  mode="edit"
                  initial={task}
                  onSubmit={(fields) =>
                    api.updateTask(task.key, fields).then(() => { setEditing(false); afterMutation(); }).catch(() => {})
                  }
                  onCancel={() => setEditing(false)}
                />
              )}

              <div className="af-sl">Spec</div>
              <div className="af-d-body">{task.spec}</div>

              <div className="af-sl">Acceptance criteria</div>
              <div className="af-d-body">{task.acceptanceCriteria}</div>

              {task.resultSummary && (<>
                <div className="af-sl">Result summary</div>
                <div className="af-result">{task.resultSummary}</div>
              </>)}

              {branchLink && (
                <Changes taskKey={task.key} branchLabel={branchLink.label} updatedAt={task.updatedAt} />
              )}

              <div className="af-sl">Metrics</div>
              <TaskMetrics metrics={task.metrics} />

              {task.links.length > 0 && (<>
                <div className="af-sl">Links</div>
                <div className="af-links">
                  {task.links.map((link) => (
                    <a key={link.id} className="af-link" href={link.url} target="_blank" rel="noreferrer" aria-label={link.label}>
                      {LINK_ICON[link.kind]({})}
                      <span className="lk">{link.label}</span>
                      <span className="ty">{link.kind}</span>
                    </a>
                  ))}
                </div>
              </>)}

              <div className="af-sl">Details</div>
              <dl className="af-def">
                <dt>Workspace</dt><dd>{task.workspace}</dd>
                <dt>Repo</dt><dd className="mono">{task.repoPath}</dd>
                <dt>Owner</dt><dd>{task.claimedAt ? (task.claimedBy ?? 'agent') : 'you'}</dd>
                <dt>Updated</dt><dd>{timeAgo(task.updatedAt)}</dd>
              </dl>

              <div className="af-sl">Activity</div>
              <div className="af-tl">
                {task.activity.map((entry) => <ActivityItem key={entry.id} entry={entry} />)}
                {task.activity.length === 0 && (
                  <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>No activity yet.</div>
                )}
              </div>

              <CommentBox onSubmit={(b) => api.addComment(task.key, b).then(afterMutation).catch(() => {})} />

              {task.status !== 'in_progress' && (
                <div className="af-danger-row">
                  <button
                    className={'af-danger' + (confirmingDelete ? ' armed' : '')}
                    onClick={() => {
                      if (!confirmingDelete) { setConfirmingDelete(true); return; }
                      api.deleteTask(task.key)
                        .then(() => { onChanged(); onClose(); })
                        .catch(() => setConfirmingDelete(false));
                    }}
                    title="Permanently deletes this task with its activity and links."
                  >
                    {confirmingDelete ? 'Confirm delete?' : 'Delete task'}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </aside>
    </>
  );
}
