import { useEffect, useMemo, useRef, useState } from 'react';
import type { Status, Task } from './types.js';
import { STATUS_LABELS } from './status.js';
import { useTasks } from './useTasks.js';
import { useWorkspaces } from './useWorkspaces.js';
import { api, setUnauthorizedHandler } from './api.js';
import { ListView } from './views/ListView.js';
import { BoardView } from './views/BoardView.js';
import { ArchiveView } from './views/ArchiveView.js';
import { AnalyticsView } from './views/AnalyticsView.js';
import { LiveView } from './views/LiveView.js';
import { TelemetryView } from './views/TelemetryView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { TaskForm } from './components/TaskForm.js';
import { WorkspacesModal } from './components/WorkspacesModal.js';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher.js';
import { TokenGate } from './components/TokenGate.js';
import { Mark, I } from './icons.js';

type View = 'board' | 'list' | 'archive' | 'analytics' | 'live' | 'telemetry';

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
  const [rangeDays, setRangeDays] = useState<number | null>(7);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingWorkspaces, setManagingWorkspaces] = useState(false);
  const [wsFilter, setWsFilter] = useState('all');
  const [query, setQuery] = useState('');
  const [lastWorkspace, setLastWorkspace] = useState('default');
  const { workspaces, refetch: refetchWorkspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks(); // all tasks; filtering is client-side
  const ticker = useChangeTicker(tasks);

  // token-mode (remote) deployments: a 401 surfaces the sign-in gate. Inert in none-mode.
  const [authNeeded, setAuthNeeded] = useState(false);
  useEffect(() => { setUnauthorizedHandler(() => setAuthNeeded(true)); }, []);

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

  const switchView = (v: View) => { setView(v); setSelectedKey(null); };
  const taskChrome = view === 'board' || view === 'list' || view === 'archive'; // search + New task



  return (
    <div id="app">
      <header className="af-header">
        <div className="af-brand">
          <Mark />
          <h1 className="af-title">AgentFactory<span className="dim"> · {view}</span></h1>
        </div>
        <span className="af-sep"></span>
        <div className="af-views">
          <button className={view === 'board' ? 'on' : ''} onClick={() => switchView('board')}>{I.board({})}Board</button>
          <button className={view === 'list' ? 'on' : ''} onClick={() => switchView('list')}>{I.list({})}List</button>
          <button className={view === 'archive' ? 'on' : ''} onClick={() => switchView('archive')}>{I.folder({})}Archive</button>
          <button className={view === 'analytics' ? 'on' : ''} onClick={() => switchView('analytics')}>{I.chart({})}Analytics</button>
          <button className={view === 'live' ? 'on' : ''} onClick={() => switchView('live')}>{I.bot({})}Live</button>
          <button className={view === 'telemetry' ? 'on' : ''} onClick={() => switchView('telemetry')}>{I.clock({})}Telemetry</button>
        </div>
        <WorkspaceSwitcher
          workspaces={workspaces}
          value={wsFilter}
          counts={counts}
          onChange={setWsFilter}
          onNewWorkspace={() => setManagingWorkspaces(true)}
        />
        {taskChrome && (
          <label className="af-search">
            {I.search({})}
            <input placeholder="Search tasks…" value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        )}

        <span className="af-spacer"></span>

        {view === 'board' && ticker && (
          <div className="af-ticker">
            <span className="ic">›</span><span>{ticker}</span>
          </div>
        )}

        {taskChrome && (
          <button className="af-btn-primary" onClick={() => setCreating(true)}>
            {I.plus({ width: 15, height: 15 })}New task
          </button>
        )}
      </header>

      {view === 'board' && (
        <BoardView
          tasks={visible}
          onSelect={setSelectedKey}
          showWorkspaceBadges={showBadges}
          workspaces={workspaces}
          onMove={moveTask}
          onAddTask={() => setCreating(true)}
          onArchiveAll={() =>
            api.archiveDone(wsFilter !== 'all' ? { workspace: wsFilter } : {}).then(refetch).catch(() => {})}
        />
      )}
      {view === 'list' && <ListView tasks={visible} multiWs={multiWs} onOpen={setSelectedKey} />}
      {view === 'archive' && <ArchiveView wsFilter={wsFilter} query={query} multiWs={multiWs} onOpen={setSelectedKey} />}
      {view === 'analytics' && <AnalyticsView ws={wsFilter} rangeDays={rangeDays} onRange={setRangeDays} />}
      {view === 'live' && <LiveView onOpen={setSelectedKey} />}
      {view === 'telemetry' && <TelemetryView onOpen={setSelectedKey} />}

      {/* Bottom tab bar — shown only on phones (CSS); the header switcher hides there */}
      <nav className="af-tabbar" aria-label="Views">
        <button className={view === 'board' ? 'on' : ''} onClick={() => switchView('board')}>{I.board({})}<span>Board</span></button>
        <button className={view === 'list' ? 'on' : ''} onClick={() => switchView('list')}>{I.list({})}<span>List</span></button>
        <button className={view === 'archive' ? 'on' : ''} onClick={() => switchView('archive')}>{I.folder({})}<span>Archive</span></button>
        <button className={view === 'analytics' ? 'on' : ''} onClick={() => switchView('analytics')}>{I.chart({})}<span>Analytics</span></button>
        <button className={view === 'live' ? 'on' : ''} onClick={() => switchView('live')}>{I.bot({})}<span>Live</span></button>
        <button className={view === 'telemetry' ? 'on' : ''} onClick={() => switchView('telemetry')}>{I.clock({})}<span>Telemetry</span></button>
      </nav>

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
              onSubmit={async (b, images) => {
                const task = await api.createTask(b);
                for (const img of images) await api.addAttachment(task.key, img);
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

      {authNeeded && <TokenGate />}
    </div>
  );
}
