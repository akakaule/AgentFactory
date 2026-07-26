import { useState, type DragEvent } from 'react';
import type { Task, Status, Workspace } from '../types.js';
import { LIFECYCLE_ORDER, tasksForColumn } from '../status.js';
import { StatusColumn } from '../components/StatusColumn.js';

// transitions a human may perform by dragging (mirrors core TRANSITIONS for actor 'human';
// not imported from core because the core package pulls in node:sqlite).
// in_review → done is deliberately NOT draggable even though core allows it: approving a
// review is the drawer's Approve action (reviewApprove), which routes git-host workspaces
// through 'delivering' and writes the override audit — a drag would silently bypass both.
const HUMAN_MOVES: Record<Status, Status[]> = {
  backlog: ['queued', 'in_review'], // in_review: park a pr-review task straight into review
  queued: ['in_review'], // pr-review rescue (kind-gated below)
  in_progress: ['queued'], // release a stranded claim
  in_review: ['queued'],
  delivering: ['queued', 'done'], // human override: re-queue for rework, or force-complete
  blocked: ['queued'],
  done: ['in_review'], // pr-review reopen-to-re-review (kind-gated below)
};

// doc stages close via Approve (which advances the stage) — dragging to Done would
// skip the stage machine; core rejects it too, this just avoids the dead drop zone.
// A pr-review task is reviewed, never implemented, so it can never be dropped into the
// queue, and the straight-into-review edges are pr-review-only (core kind-gates both;
// this hides the dead zones — and the footguns).
export const canDropTask = (task: Task, to: Status): boolean =>
  HUMAN_MOVES[task.status].includes(to)
  && (to !== 'done' || task.stage === 'implementation')
  && (to !== 'queued' || task.kind !== 'pr-review')
  && (to !== 'in_review' || task.kind === 'pr-review');

interface Props {
  tasks: Task[];
  onSelect: (key: string) => void;
  showWorkspaceBadges?: boolean;
  workspaces?: Workspace[];
  onMove?: (key: string, to: Status) => void;
  onAddTask?: () => void;
  onArchiveAll?: () => void;
}

export function BoardView({ tasks, onSelect, showWorkspaceBadges, workspaces, onMove, onAddTask, onArchiveAll }: Props) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);

  const dragged = draggingKey ? tasks.find((t) => t.key === draggingKey) : undefined;
  const canDrop = (to: Status) => !!dragged && canDropTask(dragged, to);

  const handleDragStart = (e: DragEvent, key: string) => {
    setDraggingKey(key);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', key);
  };
  const handleDragEnd = () => { setDraggingKey(null); setDragOverCol(null); };

  return (
    <div className="af-board">
      {LIFECYCLE_ORDER.map((status) => (
        <StatusColumn
          key={status}
          status={status}
          tasks={tasksForColumn(status, tasks)}
          onSelect={onSelect}
          showWorkspaceBadges={showWorkspaceBadges}
          workspaces={workspaces ?? []}
          dragOver={dragOverCol === status && canDrop(status)}
          draggingKey={draggingKey}
          onDragStart={onMove ? handleDragStart : undefined}
          onDragEnd={handleDragEnd}
          onDragOver={(e) => {
            if (!canDrop(status)) return;
            e.preventDefault();
            if (dragOverCol !== status) setDragOverCol(status);
          }}
          onDrop={(e) => {
            e.preventDefault();
            if (draggingKey && canDrop(status) && onMove) onMove(draggingKey, status);
            handleDragEnd();
          }}
          onAddTask={status === 'backlog' ? onAddTask : undefined}
          onArchiveAll={status === 'done' ? onArchiveAll : undefined}
        />
      ))}
    </div>
  );
}
