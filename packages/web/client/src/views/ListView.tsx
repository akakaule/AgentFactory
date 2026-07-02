import type { Task } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS } from '../status.js';
import { shortTime } from '../time.js';

// active work first, archive last (per the design handoff)
const ORDER: Record<Task['status'], number> = {
  in_progress: 0, in_review: 1, delivering: 2, blocked: 3, queued: 4, backlog: 5, done: 6,
};

interface Props {
  tasks: Task[];
  multiWs?: boolean | undefined;
  onOpen: (key: string) => void;
}

export function ListView({ tasks, multiWs, onOpen }: Props) {
  const rows = tasks.slice().sort(
    (x, y) => (ORDER[x.status] - ORDER[y.status]) || (Date.parse(y.updatedAt) - Date.parse(x.updatedAt)),
  );
  return (
    <div className="af-list">
      <div className="af-list-inner">
        <table className="lst">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Key</th>
              <th>Title</th>
              {multiWs && <th style={{ width: 110 }}>Workspace</th>}
              <th style={{ width: 130 }}>Status</th>
              <th style={{ width: 130 }}>Owner</th>
              <th style={{ width: 90 }}>Updated</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.key} onClick={() => onOpen(t.key)}>
                <td className="k">{t.key}</td>
                <td className="ti">{t.title}</td>
                {multiWs && <td className="k">{t.workspace}</td>}
                <td>
                  <span className="st" style={{ color: STATUS_COLORS[t.status] }}>
                    <span className="dot" style={{ background: STATUS_COLORS[t.status] }}></span>
                    {STATUS_LABELS[t.status]}
                  </span>
                </td>
                <td className="k">{t.claimedAt ? (t.claimedBy ?? 'agent') : 'you'}</td>
                <td className="k" style={{ color: 'var(--ink-3)' }}>{shortTime(t.updatedAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
