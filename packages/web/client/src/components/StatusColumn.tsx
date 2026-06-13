import type { DragEvent } from 'react';
import type { Task, Status, Workspace } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS } from '../status.js';
import { TaskCard } from './TaskCard.js';
import { wsColor } from '../wsColor.js';
import { I } from '../icons.js';

interface Props {
  status: Status;
  tasks: Task[];
  onSelect: (key: string) => void;
  showWorkspaceBadges?: boolean | undefined;
  workspaces?: Workspace[] | undefined;
  dragOver?: boolean | undefined;
  draggingKey?: string | null | undefined;
  onDragStart?: ((e: DragEvent, key: string) => void) | undefined;
  onDragEnd?: (() => void) | undefined;
  onDragOver?: ((e: DragEvent) => void) | undefined;
  onDrop?: ((e: DragEvent) => void) | undefined;
  onAddTask?: (() => void) | undefined;
  onArchiveAll?: (() => void) | undefined;
}

export function StatusColumn({
  status, tasks, onSelect, showWorkspaceBadges, workspaces = [],
  dragOver, draggingKey, onDragStart, onDragEnd, onDragOver, onDrop, onAddTask, onArchiveAll,
}: Props) {
  const hue = STATUS_COLORS[status];
  return (
    <section
      className={'af-col' + (dragOver ? ' dragover' : '')}
      onDragOver={onDragOver}
      onDrop={onDrop}
      aria-label={STATUS_LABELS[status]}
    >
      <div className="af-col-rail" style={{ background: hue }}></div>
      <div className="af-col-head">
        <span className="af-col-dot" style={{ background: hue }}></span>
        <span className="af-col-name">{STATUS_LABELS[status]}</span>
        <span className="af-col-count">{tasks.length}</span>
      </div>
      <div className="af-col-body">
        {tasks.length === 0 && <div className="af-col-empty">No tasks</div>}
        {tasks.map((task) => (
          <TaskCard
            key={task.key}
            task={task}
            onOpen={onSelect}
            showWorkspace={showWorkspaceBadges}
            wsHue={wsColor(workspaces, task.workspace)}
            dragging={draggingKey === task.key}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
        {status === 'backlog' && onAddTask && (
          <button className="af-add" onClick={onAddTask}>{I.plus({})}Add task</button>
        )}
        {status === 'done' && onArchiveAll && tasks.length > 0 && (
          <button className="af-add" onClick={onArchiveAll} title="Archive every Done task in the current workspace selection.">
            {I.folder({})}Archive all
          </button>
        )}
      </div>
    </section>
  );
}
