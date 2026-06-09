import type { Task } from '../types.js';
import { LIFECYCLE_ORDER } from '../status.js';
import { StatusColumn } from '../components/StatusColumn.js';

interface Props {
  tasks: Task[];
  onSelect: (key: string) => void;
}

export function BoardView({ tasks, onSelect }: Props) {
  return (
    <div style={{ display: 'flex', gap: '12px', overflowX: 'auto', padding: '8px 0' }}>
      {LIFECYCLE_ORDER.map((status) => (
        <StatusColumn
          key={status}
          status={status}
          tasks={tasks.filter((t) => t.status === status)}
          onSelect={onSelect}
        />
      ))}
    </div>
  );
}
