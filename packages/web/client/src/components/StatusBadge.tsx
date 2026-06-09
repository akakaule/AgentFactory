import type { Status } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS } from '../status.js';

export { STATUS_LABELS, STATUS_COLORS } from '../status.js';
export { LIFECYCLE_ORDER } from '../status.js';

interface Props {
  status: Status;
}

export function StatusBadge({ status }: Props) {
  const label = STATUS_LABELS[status];
  const color = STATUS_COLORS[status];
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: '12px',
        backgroundColor: color,
        color: '#fff',
        fontSize: '0.75rem',
        fontWeight: 600,
        whiteSpace: 'nowrap',
      }}
    >
      {label}
    </span>
  );
}
