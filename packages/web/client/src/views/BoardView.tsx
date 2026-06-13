import { useState, type DragEvent } from 'react';
import type { Task, Status, Workspace } from '../types.js';
import { LIFECYCLE_ORDER } from '../status.js';
import { StatusColumn } from '../components/StatusColumn.js';

// transitions a human may perform by dragging (mirrors core TRANSITIONS for actor 'human';
// not imported from core because the core package pulls in node:sqlite)
const HUMAN_MOVES: Record<Status, Status[]> = {
  backlog: ['queued'],
  queued: [],
  in_progress: ['queued'], // release a stranded claim
  in_review: ['queued', 'done'],
  blocked: ['queued'],
  done: [],
};

interface Props {
  tasks: Task[];
  onSelect: (key: string) => void;
  showWorkspaceBadges?: boolean;
  workspaces?: Workspace[];
  onMove?: (key: string, to: Status) => void;
  onAddTask?: () => void;
}

export function BoardView({ tasks, onSelect, showWorkspaceBadges, workspaces, onMove, onAddTask }: Props) {
  const [draggingKey, setDraggingKey] = useState<string | null>(null);
  const [dragOverCol, setDragOverCol] = useState<Status | null>(null);

  const dragged = draggingKey ? tasks.find((t) => t.key === draggingKey) : undefined;
  // doc stages close via Approve (which advances the stage) — dragging to Done would
  // skip the stage machine; core rejects it too, this just avoids the dead drop zone
  const canDrop = (to: Status) =>
    !!dragged && HUMAN_MOVES[dragged.status].includes(to) && (to !== 'done' || dragged.stage === 'implementation');

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
          tasks={tasks.filter((t) => t.status === status)}
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
        />
      ))}
    </div>
  );
}
