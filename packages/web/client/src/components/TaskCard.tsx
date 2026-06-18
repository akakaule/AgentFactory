import type { DragEvent } from 'react';
import type { Task } from '../types.js';
import { STATUS_COLORS, STAGE_LABELS, STAGE_COLORS } from '../status.js';
import { shortTime } from '../time.js';
import { taskBranch } from '../branch.js';
import { AiReviewChip } from './AiReviewChip.js';
import { FailureChip } from './FailureChip.js';
import { I } from '../icons.js';

interface Props {
  task: Task;
  onOpen: (key: string) => void;
  showWorkspace?: boolean | undefined;
  wsHue?: string | undefined;
  dragging?: boolean | undefined;
  onDragStart?: ((e: DragEvent, key: string) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
}

function ActorChip({ task }: { task: Task }) {
  if (task.claimedAt) {
    const live = task.status === 'in_progress';
    return (
      <span className={'af-actor agent' + (live ? ' run' : '')}>
        {live ? <span className="af-runpip"></span> : <span className="av">{I.bot({})}</span>}
        {task.claimedBy ?? 'agent'}
        {live ? ' · working' : ''}
      </span>
    );
  }
  return (
    <span className="af-actor human">
      <span className="av">{I.person({})}</span>you
    </span>
  );
}

export function TaskCard({ task, onOpen, showWorkspace, wsHue, dragging, onDragStart, onDragEnd }: Props) {
  return (
    <div
      className={'af-card' + (dragging ? ' dragging' : '')}
      draggable={!!onDragStart}
      onDragStart={onDragStart ? (e) => onDragStart(e, task.key) : undefined}
      onDragEnd={onDragEnd}
      onClick={() => onOpen(task.key)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(task.key); }}
    >
      <span className="af-bar" style={{ background: STATUS_COLORS[task.status] }}></span>
      <div className="af-card-top">
        <span className="af-key">{task.key}</span>
        {showWorkspace && <span className="af-wsbadge" style={{ color: wsHue }}>{task.workspace}</span>}
        <ActorChip task={task} />
      </div>
      <div className="af-card-title">{task.title}</div>
      {task.spec && <div className="af-card-spec">{task.spec}</div>}
      <div className="af-card-meta">
        <span className="af-chip" style={{ color: STAGE_COLORS[task.stage] }}>{STAGE_LABELS[task.stage]}</span>
        {/* branch exists by convention once a worker claims the task — but only at the
            implementation stage; doc-stage claims never touch the repo */}
        {task.claimedAt && task.stage === 'implementation' && <span className="af-chip">{I.branch({})}<span className="tx">{taskBranch(task.key, task.title)}</span></span>}
        {/* surfaces a supervisor failure (timeout/crash/denial/out-of-attempts) right on the card */}
        <FailureChip failure={task.failure} />
        {task.status === 'in_review' && <span className="af-tag review">{I.check({})}Needs review</span>}
        {task.status === 'in_review' && <AiReviewChip review={task.aiReview} />}
        <span className="af-meta-i">{I.clock({})}{shortTime(task.updatedAt)}</span>
      </div>
    </div>
  );
}
