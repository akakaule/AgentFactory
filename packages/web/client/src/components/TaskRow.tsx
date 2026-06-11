import type { Task } from '../types.js';
import { timeAgo } from '../time.js';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  task: Task;
  onSelect: (key: string) => void;
  showWorkspace?: boolean | undefined;
}

export function TaskRow({ task, onSelect, showWorkspace }: Props) {
  return (
    <div
      role="button"
      tabIndex={0}
      onClick={() => onSelect(task.key)}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onSelect(task.key); }}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '8px',
        padding: '8px 12px',
        borderBottom: '1px solid var(--line-soft)',
        cursor: 'pointer',
      }}
    >
      <span className="af-key" style={{ minWidth: '64px' }}>{task.key}</span>
      <span style={{ flex: 1, color: 'var(--ink)' }}>{task.title}</span>
      {task.status === 'in_progress' && task.claimedAt && (
        <span style={{ fontSize: '0.75rem', color: 'var(--active-2)' }}>
          {task.claimedBy ?? 'claimed'} · {timeAgo(task.claimedAt)}
        </span>
      )}
      {showWorkspace && <span className="af-wsbadge">{task.workspace}</span>}
      <StatusBadge status={task.status} />
    </div>
  );
}
