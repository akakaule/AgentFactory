import { useEffect, useMemo, useRef, useState } from 'react';
import type { Status, Task } from './types.js';
import { STATUS_LABELS } from './status.js';
import { useTasks } from './useTasks.js';
import { useWorkspaces } from './useWorkspaces.js';
import { api } from './api.js';
import { GroupedList } from './views/GroupedList.js';
import { BoardView } from './views/BoardView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { TaskForm } from './components/TaskForm.js';
import { WorkspacesModal } from './components/WorkspacesModal.js';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher.js';
import { Mark, I } from './icons.js';

type View = 'board' | 'list';

/** ticker line derived from real board changes between SSE refetches */
function useChangeTicker(tasks: Task[]): string | null {
  const [line, setLine] = useState<string | null>(null);
  const prev = useRef<Map<string, Status> | null>(null);
  useEffect(() => {
    const cur = new Map(tasks.map((t) => [t.key, t.status] as const));
    if (prev.current !== null) {
      for (const [key, status] of cur) {
        const before = prev.current.get(key);
        if (before === undefined) { setLine(`${key} created`); break; }
        if (before !== status) { setLine(`${key} → ${STATUS_LABELS[status]}`); break; }
      }
    }
    if (tasks.length > 0 || prev.current !== null) prev.current = cur;
  }, [tasks]);
  return line;
}

export function App() {
  const [view, setView] = useState<View>('board');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingWorkspaces, setManagingWorkspaces] = useState(false);
  const [wsFilter, setWsFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [lastWorkspace, setLastWorkspace] = useState('default');
  const { workspaces, refetch: refetchWorkspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks(); // all tasks; filtering is client-side
  const ticker = useChangeTicker(tasks);

  const multiWs = workspaces.length >= 2;
  const showBadges = multiWs && wsFilter === 'all'; // badge only in the all-workspaces view

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: tasks.length };
    for (const w of workspaces) c[w.name] = tasks.filter((t) => t.workspace === w.name).length;
    return c;
  }, [tasks, workspaces]);

  const q = query.trim().toLowerCase();
  const visible = tasks.filter((t) =>
    (wsFilter === 'all' || t.workspace === wsFilter) &&
    (!q || t.key.toLowerCase().includes(q) || t.title.toLowerCase().includes(q) || t.spec.toLowerCase().includes(q)));

  const moveTask = (key: string, to: Status) => {
    api.setStatus(key, to).then(refetch).catch(() => {});
  };

  return (
    <div id="app">
      <header className="af-header">
        <div className="af-brand">
          <Mark />
          <h1 className="af-title">AgentFactory<span className="dim"> · board</span></h1>
        </div>
        <span className="af-sep"></span>
        <WorkspaceSwitcher
          workspaces={workspaces}
          value={wsFilter}
          counts={counts}
          onChange={setWsFilter}
          onNewWorkspace={() => setManagingWorkspaces(true)}
        />
        <label className="af-search">
          {I.search({})}
          <input placeholder="Search tasks…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>

        <span className="af-spacer"></span>

        {ticker && (
          <div className="af-ticker">
            <span className="ic">›</span><span>{ticker}</span>
          </div>
        )}

        <div className="af-view">
          <button className={view === 'list' ? 'on' : ''} onClick={() => setView('list')}>List</button>
          <button className={view === 'board' ? 'on' : ''} onClick={() => setView('board')}>Board</button>
        </div>

        <button className="af-btn-primary" onClick={() => setCreating(true)}>
          {I.plus({ width: 15, height: 15 })}New task
        </button>
      </header>

      {view === 'board' ? (
        <BoardView
          tasks={visible}
          onSelect={setSelectedKey}
          showWorkspaceBadges={showBadges}
          workspaces={workspaces}
          onMove={moveTask}
          onAddTask={() => setCreating(true)}
        />
      ) : (
        <main className="af-main">
          <GroupedList tasks={visible} onSelect={setSelectedKey} showWorkspaceBadges={showBadges} />
        </main>
      )}

      {selectedKey && (
        <DetailPanel
          taskKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          onChanged={refetch}
        />
      )}

      {creating && (
        <div className="af-overlay">
          <div className="af-modal">
            <TaskForm
              mode="create"
              workspaces={workspaces.map((w) => w.name)}
              initialWorkspace={wsFilter !== 'all' ? wsFilter : lastWorkspace}
              onSubmit={async (b) => {
                await api.createTask(b);
                if (b.workspace) setLastWorkspace(b.workspace);
                setCreating(false);
                refetch();
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        </div>
      )}

      {managingWorkspaces && (
        <WorkspacesModal
          workspaces={workspaces}
          onCreated={refetchWorkspaces}
          onClose={() => setManagingWorkspaces(false)}
        />
      )}
    </div>
  );
}
