import { useState, useCallback, useEffect, type ReactElement } from 'react';
import type { TaskDetail, Activity, LinkKind } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS, STAGE_LABELS, STAGE_COLORS } from '../status.js';
import { api, attachmentUrl } from '../api.js';
import { timeAgo, shortTime } from '../time.js';
import { useEventStream } from '../useEventStream.js';
import { CommentBox } from './CommentBox.js';
import { ReviewActions } from './ReviewActions.js';
import { CopyButton } from './CopyButton.js';
import { composePrReview } from '../composePrReview.js';
import { LiveSection } from './LiveSection.js';
import { TranscriptSection } from './TranscriptSection.js';
import { VisualizationSection } from './VisualizationSection.js';
import { AiReviewChip } from './AiReviewChip.js';
import { FailureBanner } from './FailureBanner.js';
import { BlockedBanner } from './BlockedBanner.js';
import { StatusTrail } from './StatusTrail.js';
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
  // prefer the attributed human name (Phase 1 actor_user_id); fall back to the machine axis
  const who = entry.actorName ?? (entry.actor === 'agent' ? 'agent' : 'you');
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
  const [expanded, setExpanded] = useState(false);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // a diff/transcript/visualization modal layered on top handles its own Escape — don't double-close
      if (document.querySelector('.af-diffmodal, .af-txmodal, .af-vizmodal')) return;
      if (expanded) setExpanded(false);
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [expanded, onClose]);

  const afterMutation = () => {
    refetch();
    onChanged();
  };

  const hue = task ? STATUS_COLORS[task.status] : 'var(--ink-2)';
  const branchLink = task?.links.filter((l) => l.kind === 'branch').at(-1);

  const head = (
    <div className="af-drawer-head">
      <span className="af-key">{taskKey}</span>
      {task && <span className="af-wsbadge">{task.workspace}</span>}
      <button
        className="af-x"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? 'Collapse to side panel' : 'Expand to full screen'}
        aria-label={expanded ? 'Collapse to side panel' : 'Expand to full screen'}
      >
        {expanded ? I.collapse({}) : I.expand({})}
      </button>
      <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );

  const body = (
        <div className="af-drawer-body">
          {error && <div style={{ color: 'var(--st-blocked)' }}>{error}</div>}
          {!task && !error && <div style={{ color: 'var(--ink-3)' }}>Loading…</div>}
          {task && (
            <>
              <span className="af-pill" style={{ color: hue, background: `color-mix(in srgb, ${hue} 16%, transparent)` }}>
                <span className="d" style={{ background: hue }}></span>{STATUS_LABELS[task.status]}
              </span>
              {task.kind === 'pr-review' ? (
                <span
                  className="af-pill"
                  style={{ marginLeft: 6, color: 'var(--accent-2)', background: 'color-mix(in srgb, var(--accent-2) 16%, transparent)' }}
                  title="A PR-review task — review a teammate's pull request. Done when you've given your review."
                >
                  <span className="d" style={{ background: 'var(--accent-2)' }}></span>PR review
                </span>
              ) : (
                <span
                  className="af-pill"
                  style={{ marginLeft: 6, color: STAGE_COLORS[task.stage], background: `color-mix(in srgb, ${STAGE_COLORS[task.stage]} 16%, transparent)` }}
                  title="Pipeline stage: description → plan → implementation"
                >
                  <span className="d" style={{ background: STAGE_COLORS[task.stage] }}></span>{STAGE_LABELS[task.stage]}
                </span>
              )}
              {task.archivedAt && (
                <span
                  className="af-pill"
                  style={{ marginLeft: 6, color: 'var(--ink-2)', background: 'color-mix(in srgb, var(--ink-2) 16%, transparent)' }}
                  title="Archived — hidden from the active board; unarchive to make it active again."
                >
                  <span className="d" style={{ background: 'var(--ink-2)' }}></span>Archived
                </span>
              )}
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
                {task.status === 'queued' && task.kind === 'pr-review' && (
                  <button
                    className="af-mini go"
                    onClick={() => api.setStatus(task.key, 'in_review').then(afterMutation).catch(() => {})}
                    title="A pr-review task belongs in review, not the worker queue — move it back to in_review."
                  >
                    Move to review
                  </button>
                )}
                {task.status === 'done' && !task.archivedAt && (<>
                  {/* A pr-review closes via "Mark reviewed" — let the curated review still be copied
                      afterward (the copy affordance otherwise lives only on the in_review actions). */}
                  {task.kind === 'pr-review' && (task.aiReview?.items?.length ?? 0) > 0 && (
                    <CopyButton body={composePrReview(task.aiReview!.items, '')} label="Copy review for the PR" />
                  )}
                  <button
                    className="af-mini"
                    onClick={() => api.setStatus(task.key, task.kind === 'pr-review' ? 'in_review' : 'queued').then(afterMutation).catch(() => {})}
                    title={task.kind === 'pr-review'
                      ? 'Reopen the review (e.g. the PR was updated) — moves it back to in_review to review again.'
                      : 'PR build failed? Comment the failure first, then reopen — the next claimant gets the full history and pushes to the same branch/PR.'}
                  >
                    Reopen
                  </button>
                  <button
                    className="af-mini"
                    onClick={() => api.archive(task.key).then(afterMutation).catch(() => {})}
                    title="Hide this task from the active board. Everything is kept; find it in the Archive view."
                  >
                    Archive
                  </button>
                </>)}
                {task.archivedAt && (
                  <button
                    className="af-mini"
                    onClick={() => api.unarchive(task.key).then(afterMutation).catch(() => {})}
                    title="Restore this task to the active board."
                  >
                    Unarchive
                  </button>
                )}
              </div>

              {task.status === 'blocked' && (
                <BlockedBanner
                  activity={task.activity}
                  onUnblock={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                />
              )}

              {task.failure && <FailureBanner failure={task.failure} activity={task.activity} />}

              {task.status === 'in_progress' && <LiveSection taskKey={task.key} />}

              <TranscriptSection taskKey={task.key} status={task.status} />

              <VisualizationSection
                taskKey={task.key}
                present={task.hasVisualization}
                generatedAt={task.visualizationGeneratedAt}
              />

              {task.aiReview && (
                <div className="af-airev-row"><AiReviewChip review={task.aiReview} /></div>
              )}

              {task.status === 'in_review' && (
                <ReviewActions
                  aiReview={task.aiReview ?? undefined}
                  stage={task.stage}
                  kind={task.kind}
                  onApprove={() => api.approve(task.key).then(afterMutation).catch(() => {})}
                  onMarkReviewed={(review) => api.markPrReviewed(task.key, review).then(afterMutation).catch(() => {})}
                  onRequestChanges={(fb) => api.requestChanges(task.key, fb).then(afterMutation).catch(() => {})}
                />
              )}

              {editing && task.status === 'backlog' && (
                <TaskForm
                  mode="edit"
                  initial={task}
                  onSubmit={(fields, images, removedIds) =>
                    api.updateTask(task.key, fields)
                      .then(async () => {
                        for (const id of removedIds) await api.deleteAttachment(id);
                        for (const img of images) await api.addAttachment(task.key, img);
                      })
                      .then(() => { setEditing(false); afterMutation(); })
                    // let failures reject so the form surfaces them (no silent swallow)
                  }
                  onCancel={() => setEditing(false)}
                />
              )}

              <div className="af-sl">Journey</div>
              <StatusTrail activity={task.activity} current={task.status} currentStage={task.stage} />

              {task.resultSummary && (<>
                <div className="af-sl">Result summary</div>
                <div className="af-result">{task.resultSummary}</div>
              </>)}

              <div className="af-sl">Spec</div>
              <div className="af-d-body">{task.spec}</div>
              {task.attachments.length > 0 && (
                <div className="af-atts">
                  {task.attachments.map((a) => (
                    <a key={a.id} className="af-att" href={attachmentUrl(a.id)} target="_blank" rel="noreferrer" title={a.filename}>
                      <img src={attachmentUrl(a.id)} alt={a.filename} />
                    </a>
                  ))}
                </div>
              )}

              <div className="af-sl">Acceptance criteria</div>
              <div className="af-d-body">{task.acceptanceCriteria}</div>

              {task.originalSpec && (<>
                <div className="af-sl">Original description</div>
                <div className="af-d-body">{task.originalSpec}</div>
                <div className="af-sl">Original acceptance criteria</div>
                <div className="af-d-body">{task.originalAcceptanceCriteria}</div>
              </>)}

              {task.plan && (<>
                <div className="af-sl">Plan</div>
                <div className="af-d-body">{task.plan}</div>
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
  );

  return expanded ? (
    <div className="af-overlay" onClick={onClose}>
      <div className="af-modal af-detail-modal" onClick={(e) => e.stopPropagation()}>
        {head}
        {body}
      </div>
    </div>
  ) : (
    <>
      <div className="af-scrim" onClick={onClose}></div>
      <aside className="af-drawer" onClick={(e) => e.stopPropagation()}>
        {head}
        {body}
      </aside>
    </>
  );
}
