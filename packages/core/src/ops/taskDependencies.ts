import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { InvalidTransitionError, NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import { transaction } from '../transaction.js';
import { findRowByKey, toDetail, touch, type TaskRow } from '../repo/tasks.js';
import {
  deleteDependency,
  dependencyExists,
  dependencyWouldCreateCycle,
  insertDependency,
} from '../repo/taskDependencies.js';

function requireTask(db: DB, key: string): TaskRow {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return row;
}

function assertDependencyEditable(row: TaskRow): void {
  if (row.status !== 'backlog' && row.status !== 'queued') {
    throw new InvalidTransitionError(
      `task dependencies are editable only in backlog or queued (got ${row.status})`,
    );
  }
}

export function addTaskDependency(
  db: DB,
  dependentKey: string,
  dependencyKey: string,
  now: () => string = nowIso,
): TaskDetail {
  return transaction(db, () => {
    const dependent = requireTask(db, dependentKey);
    const dependency = requireTask(db, dependencyKey);
    if (dependent.id === dependency.id) {
      throw new ValidationError(`a task cannot depend on itself: ${dependentKey}`);
    }
    assertDependencyEditable(dependent);

    if (!dependencyExists(db, dependent.id, dependency.id)) {
      if (dependencyWouldCreateCycle(db, dependent.id, dependency.id)) {
        throw new InvalidTransitionError(
          `task dependency would create a cycle: ${dependentKey} -> ${dependencyKey}`,
        );
      }
      const ts = now();
      if (insertDependency(db, dependent.id, dependency.id, ts)) touch(db, dependent.id, ts);
    }

    return toDetail(db, requireTask(db, dependentKey));
  });
}

export function removeTaskDependency(
  db: DB,
  dependentKey: string,
  dependencyKey: string,
  now: () => string = nowIso,
): TaskDetail {
  return transaction(db, () => {
    const dependent = requireTask(db, dependentKey);
    const dependency = requireTask(db, dependencyKey);
    if (dependent.id === dependency.id) {
      throw new ValidationError(`a task cannot depend on itself: ${dependentKey}`);
    }
    assertDependencyEditable(dependent);

    if (dependencyExists(db, dependent.id, dependency.id)) {
      const ts = now();
      if (deleteDependency(db, dependent.id, dependency.id)) touch(db, dependent.id, ts);
    }

    return toDetail(db, requireTask(db, dependentKey));
  });
}
