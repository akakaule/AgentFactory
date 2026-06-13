import { useCallback, useEffect, useState } from 'react';
import type { Task } from '../types.js';
import { api } from '../api.js';
import { useEventStream } from '../useEventStream.js';
import { shortTime } from '../time.js';

interface Props {
  wsFilter: string; // 'all' or a workspace slug — same filter the board uses
  query: string;    // the shared header search input
  multiWs?: boolean | undefined;
  onOpen: (key: string) => void;
}

export function ArchiveView({ wsFilter, query, multiWs, onOpen }: Props) {
  const [tasks, setTasks] = useState<Task[]>([]);
  const refetch = useCallback(() => {
    api.listTasks({ archived: true }).then(setTasks).catch(() => {});
  }, []);
  useEffect(() => { refetch(); }, [refetch]);
  useEventStream(refetch);

  const q = query.trim().toLowerCase();
  const rows = tasks
    .filter((t) =>
      (wsFilter === 'all' || t.workspace === wsFilter) &&
      (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.spec.toLowerCase().includes(q)))
    .sort((x, y) => Date.parse(y.archivedAt ?? y.updatedAt) - Date.parse(x.archivedAt ?? x.updatedAt));

  return (
    <div className="af-list">
      <div className="af-list-inner">
        <table className="lst">
          <thead>
            <tr>
              <th style={{ width: 70 }}>Key</th>
              <th>Title</th>
              {multiWs && <th style={{ width: 110 }}>Workspace</th>}
              <th style={{ width: 110 }}>Archived</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.key} onClick={() => onOpen(t.key)}>
                <td className="k">{t.key}</td>
                <td className="ti">{t.title}</td>
                {multiWs && <td className="k">{t.workspace}</td>}
                <td className="k" style={{ color: 'var(--ink-3)' }}>{t.archivedAt ? shortTime(t.archivedAt) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="af-col-empty" style={{ padding: 16 }}>No archived tasks.</div>
        )}
      </div>
    </div>
  );
}
