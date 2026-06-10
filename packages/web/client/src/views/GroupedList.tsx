import type { Task } from '../types.js';
import { LIFECYCLE_ORDER, STATUS_LABELS } from '../status.js';
import { TaskRow } from '../components/TaskRow.js';

interface Props {
  tasks: Task[];
  onSelect: (key: string) => void;
  showWorkspaceBadges?: boolean;
}

export function GroupedList({ tasks, onSelect, showWorkspaceBadges }: Props) {
  return (
    <div>
      {LIFECYCLE_ORDER.map((status) => {
        const group = tasks.filter((t) => t.status === status);
        if (group.length === 0) return null;
        return (
          <div key={status} style={{ marginBottom: '16px' }}>
            <h3 style={{ margin: '0 0 4px 0', padding: '4px 12px', backgroundColor: '#f5f5f5', fontSize: '0.9rem' }}>
              {STATUS_LABELS[status]}
            </h3>
            {group.map((task) => (
              <TaskRow key={task.key} task={task} onSelect={onSelect} showWorkspace={showWorkspaceBadges} />
            ))}
          </div>
        );
      })}
    </div>
  );
}
