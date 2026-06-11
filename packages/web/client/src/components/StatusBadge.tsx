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
      className="af-pill"
      style={{
        color,
        background: `color-mix(in srgb, ${color} 16%, transparent)`,
        fontSize: '0.72rem',
        whiteSpace: 'nowrap',
      }}
    >
      <span className="d" style={{ background: color }}></span>
      {label}
    </span>
  );
}
