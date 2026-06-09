import type { Task } from '../types.js';
import { StatusBadge } from './StatusBadge.js';

interface Props {
  task: Task;
  onSelect: (key: string) => void;
}

export function TaskRow({ task, onSelect }: Props) {
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
        borderBottom: '1px solid #e0e0e0',
        cursor: 'pointer',
      }}
    >
      <span style={{ fontFamily: 'monospace', color: '#666', fontSize: '0.85rem', minWidth: '80px' }}>
        {task.key}
      </span>
      <span style={{ flex: 1 }}>{task.title}</span>
      <StatusBadge status={task.status} />
    </div>
  );
}
