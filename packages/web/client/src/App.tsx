import { useState } from 'react';
import { useTasks } from './useTasks.js';
import { api } from './api.js';
import { GroupedList } from './views/GroupedList.js';
import { BoardView } from './views/BoardView.js';
import { DetailPanel } from './components/DetailPanel.js';
import { TaskForm } from './components/TaskForm.js';

type View = 'list' | 'board';

export function App() {
  const [view, setView] = useState<View>('list');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const { tasks, refetch } = useTasks();

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
          <GroupedList tasks={tasks} onSelect={setSelectedKey} />
        ) : (
          <BoardView tasks={tasks} onSelect={setSelectedKey} />
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
              onSubmit={async (b) => {
                await api.createTask(b);
                setCreating(false);
                refetch();
              }}
              onCancel={() => setCreating(false)}
            />
          </div>
        </div>
      )}
    </div>
  );
}
