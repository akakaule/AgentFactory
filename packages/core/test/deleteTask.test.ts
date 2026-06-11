import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';
import { deleteTask } from '../src/ops/deleteTask.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { DB } from '../src/db.js';
import type { Status } from '../src/types.js';

const rows = (db: DB, sql: string, ...args: (string | number)[]) =>
  (db.prepare(sql).get(...args) as { n: number }).n;

describe('deleteTask', () => {
  it('hard-deletes the task together with its activity and links', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addComment(db, task.key, { actor: 'human', body: 'a note' });
    db.prepare("INSERT INTO link (task_id, kind, label, url) VALUES (?, 'branch', 'task/AF-1', 'http://example.com/b')").run(task.id);
    expect(rows(db, 'SELECT COUNT(*) n FROM activity WHERE task_id = ?', task.id)).toBeGreaterThan(0);

    deleteTask(db, task.key);

    expect(findRowByKey(db, task.key)).toBeFalsy();
    expect(rows(db, 'SELECT COUNT(*) n FROM activity WHERE task_id = ?', task.id)).toBe(0);
    expect(rows(db, 'SELECT COUNT(*) n FROM link WHERE task_id = ?', task.id)).toBe(0);
  });

  it.each<Status>(['backlog', 'queued', 'in_review', 'blocked', 'done'])(
    'deletes a %s task',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare('UPDATE task SET status = ? WHERE key = ?').run(status, task.key);

      deleteTask(db, task.key);

      expect(findRowByKey(db, task.key)).toBeFalsy();
    },
  );

  it('rejects deleting an in_progress task and changes nothing', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status = 'in_progress' WHERE key = ?").run(task.key);

    expect(() => deleteTask(db, task.key)).toThrow(InvalidTransitionError);

    expect(findRowByKey(db, task.key)).toBeTruthy();
    expect(rows(db, 'SELECT COUNT(*) n FROM activity WHERE task_id = ?', task.id)).toBeGreaterThan(0);
  });

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();
    expect(() => deleteTask(db, 'AF-9999')).toThrow(NotFoundError);
  });
});
