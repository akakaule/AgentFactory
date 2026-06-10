import { useState } from 'react';
import { useTasks } from './useTasks.js';
import { useWorkspaces } from './useWorkspaces.js';
import { api } from './api.js';
import { GroupedList } from './views/GroupedList.js';
import { BoardView } from './views/BoardView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { TaskForm } from './components/TaskForm.js';
import { WorkspacesModal } from './components/WorkspacesModal.js';

type View = 'list' | 'board';

export function App() {
  const [view, setView] = useState<View>('list');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [managingWorkspaces, setManagingWorkspaces] = useState(false);
  const [workspaceFilter, setWorkspaceFilter] = useState<string | null>(null);
  const [lastWorkspace, setLastWorkspace] = useState('default');
  const { workspaces, refetch: refetchWorkspaces } = useWorkspaces();
  const { tasks, refetch } = useTasks(workspaceFilter);

  const multiWorkspace = workspaces.length >= 2;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', height: '100vh', display: 'flex', flexDirection: 'column' }}>
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '12px',
          padding: '12px 20px',
          borderBottom: '1px solid #e0e0e0',
          backgroundColor: '#fff',
          position: 'sticky',
          top: 0,
          zIndex: 10,
        }}
      >
        <h1 style={{ margin: 0, fontSize: '1.25rem' }}>AgentFactory</h1>
        {multiWorkspace && (
          <select
            aria-label="Workspace filter"
            value={workspaceFilter ?? ''}
            onChange={(e) => setWorkspaceFilter(e.target.value || null)}
            style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid #ccc' }}
          >
            <option value="">All workspaces</option>
            {workspaces.map((w) => (
              <option key={w.id} value={w.name}>{w.name}</option>
            ))}
          </select>
        )}
        <div style={{ display: 'flex', gap: '4px', marginLeft: 'auto' }}>
          <button
            onClick={() => setView('list')}
            style={{
              padding: '4px 12px',
              backgroundColor: view === 'list' ? '#5b8def' : '#f0f0f0',
              color: view === 'list' ? '#fff' : '#333',
              border: 'none',
              borderRadius: '4px 0 0 4px',
              cursor: 'pointer',
            }}
          >
            List
          </button>
          <button
            onClick={() => setView('board')}
            style={{
              padding: '4px 12px',
              backgroundColor: view === 'board' ? '#5b8def' : '#f0f0f0',
              color: view === 'board' ? '#fff' : '#333',
              border: 'none',
              borderRadius: '0 4px 4px 0',
              cursor: 'pointer',
            }}
          >
            Board
          </button>
        </div>
        <button
          onClick={() => setManagingWorkspaces(true)}
          style={{
            padding: '4px 14px',
            backgroundColor: '#f0f0f0',
            color: '#333',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Workspaces
        </button>
        <button
          onClick={() => setCreating(true)}
          style={{
            padding: '4px 14px',
            backgroundColor: '#46c878',
            color: '#fff',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          New task
        </button>
      </header>

      {/* Main content */}
      <main style={{ flex: 1, overflowY: 'auto', padding: '16px 20px' }}>
        {view === 'list' ? (
          <GroupedList tasks={tasks} onSelect={setSelectedKey} showWorkspaceBadges={multiWorkspace} />
        ) : (
          <BoardView tasks={tasks} onSelect={setSelectedKey} showWorkspaceBadges={multiWorkspace} />
        )}
      </main>

      {/* Detail panel (slide-over) */}
      {selectedKey && (
        <DetailPanel
          taskKey={selectedKey}
          onClose={() => setSelectedKey(null)}
          onChanged={refetch}
        />
      )}

      {/* Create task modal */}
      {creating && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            backgroundColor: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 200,
          }}
        >
          <div
            style={{
              backgroundColor: '#fff',
              borderRadius: '8px',
              width: '560px',
              maxWidth: '95vw',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <TaskForm
              mode="create"
              workspaces={workspaces.map((w) => w.name)}
              initialWorkspace={lastWorkspace}
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

      {/* Workspaces modal */}
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
