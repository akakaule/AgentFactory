import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { getTask } from '../src/ops/getTask.js';
import { NotFoundError } from '../src/errors.js';

describe('getTask', () => {
  it('returns TaskDetail including the status_change activity row from createTask', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const detail = getTask(db, task.key);

    // Task fields pass-through
    expect(detail.id).toBe(task.id);
    expect(detail.key).toBe(task.key);
    expect(detail.title).toBe(task.title);
    expect(detail.status).toBe('backlog');

    // Activity: exactly 1 row written by createTask
    expect(detail.activity).toHaveLength(1);
    expect(detail.activity[0].type).toBe('status_change');
    expect(detail.activity[0].actor).toBe('human');
    expect(detail.activity[0].fromStatus).toBeNull();
    expect(detail.activity[0].toStatus).toBe('backlog');

    // Links: empty on a freshly created task
    expect(detail.links).toEqual([]);
  });

  it('activity is returned in chronological order (oldest first)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    // Insert two additional activity rows with raw SQL to test ordering
    db.prepare(
      "INSERT INTO activity(task_id, type, actor, from_status, to_status, body, created_at) VALUES (?, 'comment', 'human', NULL, NULL, 'second', '2025-01-01T00:00:01.000Z')"
    ).run(task.id);
    db.prepare(
      "INSERT INTO activity(task_id, type, actor, from_status, to_status, body, created_at) VALUES (?, 'comment', 'agent', NULL, NULL, 'third', '2025-01-01T00:00:02.000Z')"
    ).run(task.id);

    const detail = getTask(db, task.key);

    expect(detail.activity).toHaveLength(3);
    // Oldest first: the status_change row (from createTask) has the lowest id
    expect(detail.activity[0].type).toBe('status_change');
    expect(detail.activity[1].body).toBe('second');
    expect(detail.activity[2].body).toBe('third');
    // ids should be ascending
    expect(detail.activity[0].id).toBeLessThan(detail.activity[1].id);
    expect(detail.activity[1].id).toBeLessThan(detail.activity[2].id);
  });

  it('throws NotFoundError for unknown key', () => {
    const db = makeTestDb();

    expect(() => getTask(db, 'AF-999')).toThrow(NotFoundError);
  });

  it('is read-only: activity count and updatedAt unchanged after the call', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const countBefore = (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(task.id) as { c: number }).c;
    const updatedAtBefore = task.updatedAt;

    getTask(db, task.key);

    const countAfter = (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(task.id) as { c: number }).c;
    const updatedAtAfter = (db.prepare('SELECT updated_at FROM task WHERE key = ?').get(task.key) as { updated_at: string }).updated_at;

    expect(countAfter).toBe(countBefore);
    expect(updatedAtAfter).toBe(updatedAtBefore);
  });
});
