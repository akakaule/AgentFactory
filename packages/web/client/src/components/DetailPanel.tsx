import { useState, useCallback, useEffect, useRef, type ReactElement } from 'react';
import type { Task, TaskDetail, TaskDetailView, Activity, LinkKind } from '../types.js';
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
import { VisualizationFrame } from './VisualizationModal.js';
import { AiReviewChip } from './AiReviewChip.js';
import { DeliveryChip } from './DeliveryChip.js';
import { DeliveringFeedback } from './DeliveringFeedback.js';
import { FailureBanner } from './FailureBanner.js';
import { BlockedBanner } from './BlockedBanner.js';
import { StatusTrail } from './StatusTrail.js';
import { TaskForm } from './TaskForm.js';
import { Changes } from './Changes.js';
import { TaskMetrics } from './TaskMetrics.js';
import { TaskDependencies } from './TaskDependencies.js';
import { IntakePanel } from './IntakePanel.js';
import { I } from '../icons.js';

interface Props {
  taskKey: string;
  tasks?: readonly Task[];
  workspaces?: string[];
  onOpenTask?: (key: string) => void;
  onClose: () => void;
  onChanged: () => void;
}

/** Tabs of the task detail dialog. */
const DETAIL_TABS = ['overview', 'changes', 'logs', 'metrics', 'activity'] as const;
type DetailTab = typeof DETAIL_TABS[number];
const DETAIL_TAB_LABELS: Record<DetailTab, string> = {
  overview: 'Overview', changes: 'Changes', logs: 'Logs', metrics: 'Metrics', activity: 'Activity',
};

const LINK_ICON: Record<LinkKind, (p: object) => ReactElement> = {
  branch: I.branch, pr: I.link, worktree: I.folder, log: I.link, url: I.link,
};

function uniqueDisplayLinks(links: TaskDetail['links']): TaskDetail['links'] {
  const seen = new Set<string>();
  return links.filter((link) => {
    const key = `${link.kind}\0${link.url.trim()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

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
        {entry.body && (/^ai-review\/v2\b/i.test(entry.body.trimStart())
          ? <details className="af-tl-text"><summary>{entry.body.split('\n')[0]}</summary><pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{entry.body}</pre></details>
          : <div className="af-tl-text">{entry.body}</div>)}
      </div>
      <span className="af-tl-time">{shortTime(entry.createdAt)}</span>
    </div>
  );
}

export function DetailPanel({ taskKey, tasks = [], workspaces = [], onOpenTask, onClose, onChanged }: Props) {
  const [task, setTask] = useState<TaskDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [tab, setTab] = useState<DetailTab>('overview');
  const [showViz, setShowViz] = useState(false);
  const currentTaskKey = useRef(taskKey);
  const requestGeneration = useRef(0);
  currentTaskKey.current = taskKey;

  const refetch = useCallback(() => {
    const requestedKey = taskKey;
    const generation = ++requestGeneration.current;
    api.getTask(requestedKey)
      .then((t) => {
        if (currentTaskKey.current !== requestedKey || requestGeneration.current !== generation) return;
        setTask(t);
        setError(null);
      })
      .catch((e: Error) => {
        if (currentTaskKey.current !== requestedKey || requestGeneration.current !== generation) return;
        setError(e.message);
      });
  }, [taskKey]);

  useEffect(() => {
    setTask(null);
    setEditing(false);
    setConfirmingDelete(false);
    setTab('overview');
    setShowViz(false);
    refetch();
  }, [refetch]);

  useEventStream(refetch);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      // a diff/transcript/visualization modal layered on top handles its own Escape — don't double-close
      if (document.querySelector('.af-diffmodal, .af-txmodal, .af-vizmodal')) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const afterMutation = () => {
    refetch();
    onChanged();
  };

  const hue = task ? STATUS_COLORS[task.status] : 'var(--ink-2)';
  const branchLink = task?.links.filter((l) => l.kind === 'branch').at(-1);
  const visibleLinks = task ? uniqueDisplayLinks(task.links) : [];

  const head = (
    <div className="af-drawer-head">
      <span className="af-key">{taskKey}</span>
      {task && <span className="af-wsbadge">{task.workspace}</span>}
      <button className="af-x" onClick={onClose} aria-label="Close">✕</button>
    </div>
  );

  const renderTask = (task: TaskDetailView) => {
    const pills = (<>
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
    </>);

    const title = (<>
      <h2 className="af-d-title">{task.title}</h2>
    </>);

    const tags = (<>
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
        {task.status === 'queued' && !editing && <button className="af-mini" onClick={() => setEditing(true)}>Edit</button>}
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
    </>);

    const dependencies = (<>
      <div className="af-sl">Dependencies</div>
      <TaskDependencies
        key={task.key}
        task={task}
        tasks={tasks}
        onOpenTask={onOpenTask}
        onMutated={afterMutation}
      />
    </>);

    const banners = (<>
      {task.status === 'blocked' && (
        <BlockedBanner
          activity={task.activity}
          onUnblock={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
        />
      )}

      {task.failure && (
        <FailureBanner
          taskKey={task.key}
          failure={task.failure}
          activity={task.activity}
          triage={task.failureTriage ?? null}
          onChanged={afterMutation}
          {...(task.failure.skipListed
            ? { onRestart: () => {
              const requestedKey = task.key;
              setError(null);
              void api.restart(requestedKey)
                .then(afterMutation)
                .catch((e: Error) => {
                  if (currentTaskKey.current === requestedKey) setError(e.message);
                });
            } }
            : {})}
        />
      )}
    </>);

    const live = (<>
      {task.status === 'in_progress' && <LiveSection taskKey={task.key} />}
    </>);

    const aiReviewRow = (<>
      {task.aiReview && (
        <div className="af-airev-row"><AiReviewChip review={task.aiReview} /></div>
      )}
    </>);

    const reviewActions = (<>
      {task.status === 'in_review' && (
        <ReviewActions
          aiReview={task.aiReview ?? undefined}
          stage={task.stage}
          kind={task.kind}
          willDeliver={task.stage === 'implementation' && task.kind === 'code' && task.branch != null}
          onApprove={() => api.approve(task.key).then(afterMutation).catch(() => {})}
          onMarkReviewed={(review) => api.markPrReviewed(task.key, review).then(afterMutation).catch(() => {})}
          onRequestChanges={(fb) => api.requestChanges(task.key, fb).then(afterMutation).catch(() => {})}
        />
      )}
    </>);

    const delivery = (<>
      {task.delivery && (
        <div className="af-delivery-sec">
          <div className="hd">
            <DeliveryChip delivery={task.delivery} />
            {task.delivery.checkedAt && (
              <span className="checked">last checked {timeAgo(task.delivery.checkedAt)}</span>
            )}
          </div>
          {task.delivery.failing.length > 0 && (
            <ul className="af-delivery-fails">
              {task.delivery.failing.map((c, i) => (
                <li key={i}>
                  {c.url
                    ? <a href={c.url} target="_blank" rel="noreferrer">{c.name}</a>
                    : <span>{c.name}</span>}
                </li>
              ))}
            </ul>
          )}
          {task.status === 'delivering' && (
            <>
              <div className="af-delivery-acts">
                {task.createPrUrl && (
                  <a
                    className="af-mini go"
                    href={task.createPrUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="Opens the git host's create-PR page with this task's branch preselected; the watcher picks the PR up on its next poll."
                  >
                    {task.delivery.provider === 'azdo' ? 'Open PR in Azure DevOps' : 'Open PR on GitHub'}
                  </a>
                )}
                <button
                  className="af-mini go"
                  onClick={() => api.setStatus(task.key, 'done').then(afterMutation).catch(() => {})}
                  title="Force-complete — use when there is no CI or the watcher is down."
                >
                  Mark done
                </button>
                <button
                  className="af-mini"
                  onClick={() => api.setStatus(task.key, 'queued').then(afterMutation).catch(() => {})}
                  title="Pull the task back to the queue for rework."
                >
                  Re-queue
                </button>
              </div>
              <DeliveringFeedback task={task} onMutated={afterMutation} />
            </>
          )}
        </div>
      )}
    </>);

    const editForm = (<>
      {/* The brief stays editable until claimed; moving workspace is backlog-only (core rule). */}
      {editing && (task.status === 'backlog' || task.status === 'queued') && (
        <TaskForm
          mode="edit"
          initial={task}
          workspaces={task.status === 'backlog' ? workspaces : []}
          initialWorkspace={task.workspace}
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
    </>);

    const journey = (<>
      <div className="af-sl">Journey</div>
      <StatusTrail activity={task.activity} current={task.status} currentStage={task.stage} />
    </>);

    const intake = (<>
      <IntakePanel task={task} onChanged={afterMutation} />
    </>);

    const result = (<>
      {task.resultSummary && (<>
        <div className="af-sl">Result summary</div>
        <div className="af-result">{task.resultSummary}</div>
      </>)}
    </>);

    const spec = (<>
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
    </>);

    const criteria = (<>
      <div className="af-sl">Acceptance criteria</div>
      <div className="af-d-body">{task.acceptanceCriteria}</div>
    </>);

    const original = (<>
      {task.originalSpec && (<>
        <div className="af-sl">Original description</div>
        <div className="af-d-body">{task.originalSpec}</div>
        <div className="af-sl">Original acceptance criteria</div>
        <div className="af-d-body">{task.originalAcceptanceCriteria}</div>
      </>)}
    </>);

    const plan = (<>
      {task.plan && (<>
        <div className="af-sl">Plan</div>
        <div className="af-d-body">{task.plan}</div>
      </>)}
    </>);

    const metrics = (<>
      <div className="af-sl">Metrics</div>
      <TaskMetrics metrics={task.metrics} />
    </>);

    const links = (<>
      {visibleLinks.length > 0 && (<>
        <div className="af-sl">Links</div>
        <div className="af-links">
          {visibleLinks.map((link) => (
            <a key={link.id} className="af-link" href={link.url} target="_blank" rel="noreferrer" aria-label={link.label}>
              {LINK_ICON[link.kind]({})}
              <span className="lk">{link.label}</span>
              <span className="ty">{link.kind}</span>
            </a>
          ))}
        </div>
      </>)}
    </>);

    const details = (<>
      <div className="af-sl">Details</div>
      <dl className="af-def">
        <dt>Workspace</dt><dd>{task.workspace}</dd>
        <dt>Repo</dt><dd className="mono">{task.repoPath}</dd>
        <dt>Owner</dt><dd>{task.claimedAt ? (task.claimedBy ?? 'agent') : 'you'}</dd>
        <dt>Updated</dt><dd>{timeAgo(task.updatedAt)}</dd>
      </dl>
    </>);

    const activity = (<>
      <div className="af-sl">Activity</div>
      <div className="af-tl">
        {task.activity.map((entry) => <ActivityItem key={entry.id} entry={entry} />)}
        {task.activity.length === 0 && (
          <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>No activity yet.</div>
        )}
      </div>
    </>);

    const comment = (<>
      <CommentBox onSubmit={(b) => api.addComment(task.key, b).then(afterMutation).catch(() => {})} />
    </>);

    const danger = (<>
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
    </>);

    // A fixed header (title + tabs) over one scrolling tab panel. Overview is an
    // Azure-DevOps-style sheet — a wide narrative column, then two equal field columns.
    const recent = task.activity.slice(-3);
    return (
      <>
        <div className="af-dt-top">
          <div>{pills}</div>
          {title}
          <div className="af-dt-strip">
            {tags}
            <div className="af-dt-tabs" role="tablist" aria-label="Task detail sections">
              {DETAIL_TABS.map((t, i) => (
                <button
                  key={t}
                  role="tab"
                  id={`af-dt-tab-${t}`}
                  aria-controls="af-dt-panel"
                  aria-selected={tab === t}
                  tabIndex={tab === t ? 0 : -1}
                  className="af-dt-tab"
                  onClick={() => setTab(t)}
                  onKeyDown={(e) => {
                    const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                    if (step === 0) return;
                    e.preventDefault();
                    const next = DETAIL_TABS[(i + step + DETAIL_TABS.length) % DETAIL_TABS.length]!;
                    setTab(next);
                    document.getElementById(`af-dt-tab-${next}`)?.focus();
                  }}
                >
                  {DETAIL_TAB_LABELS[t]}
                  {t === 'activity' && task.activity.length > 0 && <span className="n">{task.activity.length}</span>}
                </button>
              ))}
            </div>
          </div>
        </div>

        <div className="af-dt-main" role="tabpanel" id="af-dt-panel" aria-labelledby={`af-dt-tab-${tab}`}>
          {tab === 'overview' && (
            <div className="af-dt-sheet">
              <div className="af-dt-col">
                {banners}{aiReviewRow}{reviewActions}{delivery}{editForm}
                {journey}{result}{spec}{criteria}{original}{plan}
                <div className="af-sl">Discussion</div>
                {comment}
                <div className="af-tl">
                  {recent.map((entry) => <ActivityItem key={entry.id} entry={entry} />)}
                </div>
                {task.activity.length > recent.length && (
                  <button className="af-dt-more" onClick={() => setTab('activity')}>
                    All {task.activity.length} activity entries →
                  </button>
                )}
              </div>
              <div className="af-dt-col">
                {details}{intake}{metrics}
              </div>
              <div className="af-dt-col">
                {links}
                {branchLink && (
                  <Changes taskKey={task.key} branchLabel={branchLink.label} updatedAt={task.updatedAt} onViewDiff={() => setTab('changes')} />
                )}
                {dependencies}{danger}
              </div>
            </div>
          )}

          {tab === 'changes' && (
            <>
              {task.hasVisualization && (
                <div className="af-dt-seg" role="group" aria-label="Changes view">
                  <button aria-pressed={!showViz} onClick={() => setShowViz(false)}>Diff</button>
                  <button aria-pressed={showViz} onClick={() => setShowViz(true)}>Visual change</button>
                </div>
              )}
              {task.hasVisualization && showViz
                ? <div className="af-dt-viz"><VisualizationFrame taskKey={task.key} /></div>
                : branchLink
                  ? <Changes taskKey={task.key} branchLabel={branchLink.label} updatedAt={task.updatedAt} inline />
                  : <div className="af-dt-empty">No branch linked yet — changes appear once the agent pushes one.</div>}
            </>
          )}

          {tab === 'logs' && (<>{live}<TranscriptSection taskKey={task.key} status={task.status} inline /></>)}

          {tab === 'metrics' && metrics}

          {tab === 'activity' && (<>{activity}{comment}</>)}
        </div>
      </>
    );
  };


  const body = (
    <div className="af-drawer-body af-dt-body">
      {error && <div style={{ color: 'var(--st-blocked)' }}>{error}</div>}
      {!task && !error && <div style={{ color: 'var(--ink-3)' }}>Loading…</div>}
      {task && renderTask(task)}
    </div>
  );

  return (
    <div className="af-overlay" onClick={onClose}>
      <div className="af-modal af-detail-modal" onClick={(e) => e.stopPropagation()}>
        {head}
        {body}
      </div>
    </div>
  );
}
