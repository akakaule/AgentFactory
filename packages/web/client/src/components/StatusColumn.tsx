import type { Task, Status } from '../types.js';
import { StatusBadge } from './StatusBadge.js';
import { TaskRow } from './TaskRow.js';

interface Props {
  status: Status;
  tasks: Task[];
  onSelect: (key: string) => void;
}

export function StatusColumn({ status, tasks, onSelect }: Props) {
  return (
    <div
      style={{
        minWidth: '220px',
        flex: '1 1 0',
        border: '1px solid #e0e0e0',
        borderRadius: '6px',
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          padding: '8px 12px',
          borderBottom: '1px solid #e0e0e0',
          backgroundColor: '#fafafa',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <StatusBadge status={status} />
        <span style={{ fontSize: '0.8rem', color: '#666' }}>{tasks.length}</span>
      </div>
      <div>
        {tasks.map((task) => (
          <TaskRow key={task.key} task={task} onSelect={onSelect} />
        ))}
      </div>
    </div>
  );
}
