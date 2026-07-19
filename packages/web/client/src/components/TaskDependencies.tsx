import { useState } from 'react';
import type { Task, TaskDetail } from '../types.js';
import { api } from '../api.js';
import { I } from '../icons.js';
import { StatusBadge } from './StatusBadge.js';

type TaskReference = TaskDetail['dependencies'][number];

interface Props {
  task: TaskDetail;
  tasks: readonly Task[];
  onOpenTask: ((key: string) => void) | undefined;
  onMutated: () => void;
}

const canEditDependencies = (status: Task['status']) => status === 'backlog' || status === 'queued';

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : 'Could not update dependencies.';
}

interface ReferenceRowProps {
  reference: TaskReference;
  onOpenTask: ((key: string) => void) | undefined;
  removeLabel: string | null;
  removing: boolean;
  onRemove: (() => void) | null;
}

function ReferenceRow({ reference, onOpenTask, removeLabel, removing, onRemove }: ReferenceRowProps) {
  return (
    <div className="af-dep-row">
      <button
        type="button"
        className="af-dep-open"
        aria-label={`${reference.key} ${reference.title}`}
        onClick={() => onOpenTask?.(reference.key)}
        disabled={!onOpenTask}
      >
        <span className="af-dep-id">
          <span className="af-key">{reference.key}</span>
          <span className="af-dep-title">{reference.title}</span>
        </span>
        <StatusBadge status={reference.status} />
        <span className="af-wsbadge">{reference.workspace}</span>
      </button>
      {onRemove && removeLabel && (
        <button
          type="button"
          className="af-dep-remove"
          aria-label={removeLabel}
          title={removeLabel}
          disabled={removing}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </div>
  );
}

export function TaskDependencies({ task, tasks, onOpenTask, onMutated }: Props) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const editable = canEditDependencies(task.status);
  const existing = new Set(task.dependencies.map((dependency) => dependency.key));
  const normalizedQuery = query.trim().toLowerCase();
  const candidates = normalizedQuery
    ? tasks
      .filter((candidate) =>
        candidate.archivedAt === null
        && candidate.key !== task.key
        && !existing.has(candidate.key)
        && `${candidate.key}\n${candidate.title}\n${candidate.workspace}`.toLowerCase().includes(normalizedQuery))
      .slice(0, 8)
    : [];

  const mutate = async (operation: string, action: () => Promise<TaskDetail>, closePicker = false) => {
    if (busy !== null) return;
    setBusy(operation);
    setError(null);
    try {
      await action();
      if (closePicker) {
        setAdding(false);
        setQuery('');
      }
      onMutated();
    } catch (mutationError) {
      setError(errorMessage(mutationError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="af-deps" aria-label="Dependencies">
      {editable && task.unmetDependencyCount > 0 && (
        <div className="af-dep-waiting">
          <span className="af-dep-wait-title">
            {I.link({})} Waiting on {task.unmetDependencyCount} {task.unmetDependencyCount === 1 ? 'dependency' : 'dependencies'}
          </span>
          <span>This task can be queued now and starts automatically when all dependencies are done.</span>
        </div>
      )}

      <div className="af-dep-heading">
        <h4>Depends on</h4>
        {editable && !adding && (
          <button type="button" className="af-mini" onClick={() => { setAdding(true); setError(null); }}>
            {I.plus({})} Add dependency
          </button>
        )}
      </div>

      {adding && (
        <div className="af-dep-picker">
          <div className="af-dep-search-row">
            <label>
              <span className="sr-only">Search tasks to depend on</span>
              <input
                autoFocus
                aria-label="Search tasks to depend on"
                placeholder="Search by key, title, or workspace…"
                value={query}
                onChange={(event) => { setQuery(event.target.value); setError(null); }}
              />
            </label>
            <button
              type="button"
              className="af-mini"
              onClick={() => { setAdding(false); setQuery(''); setError(null); }}
            >
              Cancel
            </button>
          </div>
          {normalizedQuery && candidates.length === 0 && (
            <div className="af-dep-empty">No matching active tasks.</div>
          )}
          {candidates.length > 0 && (
            <div className="af-dep-results">
              {candidates.map((candidate) => {
                const operation = `add:${candidate.key}`;
                return (
                  <button
                    key={candidate.key}
                    type="button"
                    className="af-dep-candidate"
                    aria-label={`Add ${candidate.key} ${candidate.title} as dependency`}
                    disabled={busy !== null}
                    onClick={() => void mutate(
                      operation,
                      () => api.addTaskDependency(task.key, candidate.key),
                      true,
                    )}
                  >
                    <span className="af-dep-id">
                      <span className="af-key">{candidate.key}</span>
                      <span className="af-dep-title">{candidate.title}</span>
                    </span>
                    <StatusBadge status={candidate.status} />
                    <span className="af-wsbadge">{candidate.workspace}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {task.dependencies.length === 0
        ? <div className="af-dep-empty">No dependencies.</div>
        : (
          <div className="af-dep-list">
            {task.dependencies.map((dependency) => {
              const operation = `remove:${task.key}:${dependency.key}`;
              return (
                <ReferenceRow
                  key={dependency.key}
                  reference={dependency}
                  onOpenTask={onOpenTask}
                  removeLabel={editable ? `Remove dependency ${dependency.key}` : null}
                  removing={busy === operation}
                  onRemove={editable
                    ? () => void mutate(operation, () => api.removeTaskDependency(task.key, dependency.key))
                    : null}
                />
              );
            })}
          </div>
        )}

      <div className="af-dep-heading af-dep-blocks-heading">
        <h4>Blocks</h4>
      </div>
      {task.dependents.length === 0
        ? <div className="af-dep-empty">No dependent tasks.</div>
        : (
          <div className="af-dep-list">
            {task.dependents.map((dependent) => {
              const dependentEditable = canEditDependencies(dependent.status);
              const operation = `remove:${dependent.key}:${task.key}`;
              return (
                <ReferenceRow
                  key={dependent.key}
                  reference={dependent}
                  onOpenTask={onOpenTask}
                  removeLabel={dependentEditable ? `Remove dependent ${dependent.key}` : null}
                  removing={busy === operation}
                  onRemove={dependentEditable
                    ? () => void mutate(operation, () => api.removeTaskDependency(dependent.key, task.key))
                    : null}
                />
              );
            })}
          </div>
        )}

      {error && <div className="af-dep-error" role="alert">{error}</div>}
    </section>
  );
}
