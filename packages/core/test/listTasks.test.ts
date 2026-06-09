import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { listTasks } from '../src/ops/listTasks.js';

describe('listTasks', () => {
  it('no filter returns all tasks ordered by seq ascending', () => {
    const db = makeTestDb();
    createTask(db, { title: 'Task 1', spec: 'S1', acceptanceCriteria: 'A1' });
    createTask(db, { title: 'Task 2', spec: 'S2', acceptanceCriteria: 'A2' });
    createTask(db, { title: 'Task 3', spec: 'S3', acceptanceCriteria: 'A3' });

    const tasks = listTasks(db);

    expect(tasks).toHaveLength(3);
    expect(tasks[0].key).toBe('AF-1');
    expect(tasks[1].key).toBe('AF-2');
    expect(tasks[2].key).toBe('AF-3');
    // verify ascending seq order
    expect(tasks[0].seq).toBeLessThan(tasks[1].seq);
    expect(tasks[1].seq).toBeLessThan(tasks[2].seq);
  });

  it('status filter returns only matching tasks', () => {
    const db = makeTestDb();
    createTask(db, { title: 'Task 1', spec: 'S1', acceptanceCriteria: 'A1' });
    createTask(db, { title: 'Task 2', spec: 'S2', acceptanceCriteria: 'A2' });
    createTask(db, { title: 'Task 3', spec: 'S3', acceptanceCriteria: 'A3' });

    // Promote one task to 'queued' via raw UPDATE
    db.prepare("UPDATE task SET status = ? WHERE key = ?").run('queued', 'AF-2');

    const queued = listTasks(db, { status: 'queued' });
    expect(queued).toHaveLength(1);
    expect(queued[0].key).toBe('AF-2');

    const backlog = listTasks(db, { status: 'backlog' });
    expect(backlog).toHaveLength(2);
    expect(backlog.map(t => t.key)).toEqual(['AF-1', 'AF-3']);
  });

  it('is read-only: updatedAt and activity count unchanged after call', () => {
    const db = makeTestDb();
    createTask(db, { title: 'T1', spec: 'S', acceptanceCriteria: 'A' });
    createTask(db, { title: 'T2', spec: 'S', acceptanceCriteria: 'A' });

    const before = listTasks(db);
    const updatedAtsBefore = before.map(t => t.updatedAt);
    const activityCountsBefore = before.map(t =>
      (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(t.id) as { c: number }).c
    );

    listTasks(db);

    const after = listTasks(db);
    const updatedAtsAfter = after.map(t => t.updatedAt);
    const activityCountsAfter = after.map(t =>
      (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(t.id) as { c: number }).c
    );

    expect(updatedAtsAfter).toEqual(updatedAtsBefore);
    expect(activityCountsAfter).toEqual(activityCountsBefore);
  });
});
