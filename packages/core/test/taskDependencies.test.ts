import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createCore } from '../src/index.js';
import { createTask } from '../src/ops/createTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { deleteTask } from '../src/ops/deleteTask.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { addTaskDependency, removeTaskDependency } from '../src/ops/taskDependencies.js';
import { getVersion } from '../src/version.js';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../src/errors.js';

const JAN = '2026-01-01T00:00:00.000Z';
const FEB = '2026-02-01T00:00:00.000Z';
const MAR = '2026-03-01T00:00:00.000Z';
const APR = '2026-04-01T00:00:00.000Z';
const MAY = '2026-05-01T00:00:00.000Z';

function setStatus(db: ReturnType<typeof makeTestDb>, key: string, status: string): void {
  db.prepare('UPDATE task SET status=? WHERE key=?').run(status, key);
}

describe('task dependencies', () => {
  it('stores the directed relationship across workspaces and enriches both detail directions', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'other', repoPath: 'C:/repo/other' }, () => JAN);
    const prerequisite = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' }, () => JAN);
    const dependent = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A', workspace: 'other' }, () => JAN);

    const detail = addTaskDependency(db, dependent.key, prerequisite.key, () => FEB);

    expect(detail.dependencies).toEqual([{
      key: prerequisite.key, title: 'First', status: 'backlog', workspace: 'default',
    }]);
    expect(detail.dependents).toEqual([]);
    expect(detail.unmetDependencyCount).toBe(1);
    expect(detail.updatedAt).toBe(FEB);
    expect(getTask(db, prerequisite.key).dependents).toEqual([{
      key: dependent.key, title: 'Second', status: 'backlog', workspace: 'other',
    }]);
    expect(getTask(db, prerequisite.key).dependencies).toEqual([]);
    expect(listTasks(db).find((task) => task.key === dependent.key)?.unmetDependencyCount).toBe(1);
  });

  it('treats duplicate adds and missing-edge removals as no-ops without touching the dependent', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' }, () => JAN);
    const dependent = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' }, () => JAN);

    addTaskDependency(db, dependent.key, prerequisite.key, () => FEB);
    const versionAfterAdd = getVersion(db);
    const duplicate = addTaskDependency(db, dependent.key, prerequisite.key, () => MAR);
    expect(duplicate.updatedAt).toBe(FEB);
    expect(getVersion(db)).toBe(versionAfterAdd);
    expect(db.prepare('SELECT count(*) c FROM task_dependency').get()).toMatchObject({ c: 1 });

    const removed = removeTaskDependency(db, dependent.key, prerequisite.key, () => APR);
    expect(removed.dependencies).toEqual([]);
    expect(removed.updatedAt).toBe(APR);
    const versionAfterRemove = getVersion(db);
    const missing = removeTaskDependency(db, dependent.key, prerequisite.key, () => MAY);
    expect(missing.updatedAt).toBe(APR);
    expect(getVersion(db)).toBe(versionAfterRemove);
  });

  it('validates both keys for add and remove', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'Only', spec: 'S', acceptanceCriteria: 'A' });

    expect(() => addTaskDependency(db, 'AF-999', task.key)).toThrow(NotFoundError);
    expect(() => addTaskDependency(db, task.key, 'AF-999')).toThrow(NotFoundError);
    expect(() => removeTaskDependency(db, 'AF-999', task.key)).toThrow(NotFoundError);
    expect(() => removeTaskDependency(db, task.key, 'AF-999')).toThrow(NotFoundError);
  });

  it('rejects self-dependencies', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'Only', spec: 'S', acceptanceCriteria: 'A' });

    expect(() => addTaskDependency(db, task.key, task.key)).toThrow(ValidationError);
  });

  it('rejects direct and transitive cycles without mutating the graph', () => {
    const db = makeTestDb();
    const first = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const second = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    const third = createTask(db, { title: 'Third', spec: 'S', acceptanceCriteria: 'A' });
    addTaskDependency(db, second.key, first.key);

    expect(() => addTaskDependency(db, first.key, second.key)).toThrow(InvalidTransitionError);
    addTaskDependency(db, third.key, second.key);
    expect(() => addTaskDependency(db, first.key, third.key)).toThrow(InvalidTransitionError);
    expect(db.prepare('SELECT count(*) c FROM task_dependency').get()).toMatchObject({ c: 2 });
  });

  it('allows edits while queued but rejects dependency edits after work starts', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const dependent = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    setStatus(db, dependent.key, 'queued');
    expect(() => addTaskDependency(db, dependent.key, prerequisite.key)).not.toThrow();

    setStatus(db, dependent.key, 'in_progress');
    expect(() => removeTaskDependency(db, dependent.key, prerequisite.key)).toThrow(InvalidTransitionError);
    expect(() => addTaskDependency(db, dependent.key, prerequisite.key)).toThrow(InvalidTransitionError);
  });

  it('counts only non-done prerequisites as unmet and reopening makes one unmet again', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const dependent = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    addTaskDependency(db, dependent.key, prerequisite.key);

    setStatus(db, prerequisite.key, 'done');
    expect(getTask(db, dependent.key).unmetDependencyCount).toBe(0);
    setStatus(db, prerequisite.key, 'backlog');
    expect(getTask(db, dependent.key).unmetDependencyCount).toBe(1);
  });

  it('cascades relationship deletion when either endpoint is deleted', () => {
    const db = makeTestDb();
    const first = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const second = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    const third = createTask(db, { title: 'Third', spec: 'S', acceptanceCriteria: 'A' });
    addTaskDependency(db, second.key, first.key);
    addTaskDependency(db, third.key, second.key);

    deleteTask(db, first.key);
    expect(db.prepare('SELECT count(*) c FROM task_dependency').get()).toMatchObject({ c: 1 });
    deleteTask(db, third.key);
    expect(db.prepare('SELECT count(*) c FROM task_dependency').get()).toMatchObject({ c: 0 });
  });

  it('is bound on createCore', () => {
    const db = makeTestDb();
    const core = createCore(db);
    const prerequisite = core.createTask({ title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const dependent = core.createTask({ title: 'Second', spec: 'S', acceptanceCriteria: 'A' });

    expect(core.addTaskDependency(dependent.key, prerequisite.key).dependencies[0]?.key).toBe(prerequisite.key);
    expect(core.removeTaskDependency(dependent.key, prerequisite.key).dependencies).toEqual([]);
  });
});

describe('dependency-aware claims', () => {
  it('skips a waiting FIFO task and claims the next eligible task', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'Prerequisite', spec: 'S', acceptanceCriteria: 'A' });
    const waiting = createTask(db, { title: 'Waiting', spec: 'S', acceptanceCriteria: 'A' });
    const eligible = createTask(db, { title: 'Eligible', spec: 'S', acceptanceCriteria: 'A' });
    setStatus(db, waiting.key, 'queued');
    setStatus(db, eligible.key, 'queued');
    addTaskDependency(db, waiting.key, prerequisite.key);

    expect(claimNextTask(db)?.key).toBe(eligible.key);
    expect(getTask(db, waiting.key).status).toBe('queued');
  });

  it('claims the dependent after every prerequisite becomes done', () => {
    const db = makeTestDb();
    const first = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const second = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    const dependent = createTask(db, { title: 'Dependent', spec: 'S', acceptanceCriteria: 'A' });
    setStatus(db, dependent.key, 'queued');
    addTaskDependency(db, dependent.key, first.key);
    addTaskDependency(db, dependent.key, second.key);
    setStatus(db, first.key, 'done');

    expect(claimNextTask(db)).toBeNull();
    setStatus(db, second.key, 'done');
    expect(claimNextTask(db)?.key).toBe(dependent.key);
  });

  it('does not claim a queued dependent after a completed prerequisite is reopened', () => {
    const db = makeTestDb();
    const prerequisite = createTask(db, { title: 'First', spec: 'S', acceptanceCriteria: 'A' });
    const dependent = createTask(db, { title: 'Second', spec: 'S', acceptanceCriteria: 'A' });
    setStatus(db, prerequisite.key, 'done');
    setStatus(db, dependent.key, 'queued');
    addTaskDependency(db, dependent.key, prerequisite.key);
    setStatus(db, prerequisite.key, 'backlog');

    expect(claimNextTask(db)).toBeNull();
    expect(getTask(db, dependent.key).status).toBe('queued');
  });
});
