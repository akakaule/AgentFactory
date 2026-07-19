import type { DB } from '../db.js';
import type { Status, TaskReference } from '../types.js';

interface TaskReferenceRow {
  key: string;
  title: string;
  status: Status;
  workspace: string;
}

export function dependenciesFor(db: DB, taskId: number): TaskReference[] {
  return db.prepare(
    `SELECT prerequisite.key, prerequisite.title, prerequisite.status, workspace.name AS workspace
     FROM task_dependency dependency
     JOIN task prerequisite ON prerequisite.id = dependency.depends_on_task_id
     JOIN workspace ON workspace.id = prerequisite.workspace_id
     WHERE dependency.task_id = ?
     ORDER BY prerequisite.seq ASC`,
  ).all(taskId) as unknown as TaskReferenceRow[];
}

export function dependentsFor(db: DB, taskId: number): TaskReference[] {
  return db.prepare(
    `SELECT dependent.key, dependent.title, dependent.status, workspace.name AS workspace
     FROM task_dependency dependency
     JOIN task dependent ON dependent.id = dependency.task_id
     JOIN workspace ON workspace.id = dependent.workspace_id
     WHERE dependency.depends_on_task_id = ?
     ORDER BY dependent.seq ASC`,
  ).all(taskId) as unknown as TaskReferenceRow[];
}

export function dependencyExists(db: DB, taskId: number, dependsOnTaskId: number): boolean {
  return db.prepare(
    'SELECT 1 FROM task_dependency WHERE task_id = ? AND depends_on_task_id = ?',
  ).get(taskId, dependsOnTaskId) !== undefined;
}

/** True when adding taskId -> dependsOnTaskId would close a direct or transitive cycle. */
export function dependencyWouldCreateCycle(db: DB, taskId: number, dependsOnTaskId: number): boolean {
  return db.prepare(
    `WITH RECURSIVE reachable(id) AS (
       SELECT depends_on_task_id
       FROM task_dependency
       WHERE task_id = ?
       UNION
       SELECT dependency.depends_on_task_id
       FROM task_dependency dependency
       JOIN reachable ON dependency.task_id = reachable.id
     )
     SELECT 1
     FROM reachable
     WHERE id = ?
     LIMIT 1`,
  ).get(dependsOnTaskId, taskId) !== undefined;
}

export function insertDependency(
  db: DB,
  taskId: number,
  dependsOnTaskId: number,
  createdAt: string,
): boolean {
  const result = db.prepare(
    `INSERT OR IGNORE INTO task_dependency(task_id, depends_on_task_id, created_at)
     VALUES (?, ?, ?)`,
  ).run(taskId, dependsOnTaskId, createdAt);
  return result.changes > 0;
}

export function deleteDependency(db: DB, taskId: number, dependsOnTaskId: number): boolean {
  const result = db.prepare(
    'DELETE FROM task_dependency WHERE task_id = ? AND depends_on_task_id = ?',
  ).run(taskId, dependsOnTaskId);
  return result.changes > 0;
}
