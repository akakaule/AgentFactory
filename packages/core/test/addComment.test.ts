import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { addComment } from '../src/ops/addComment.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { ValidationError, NotFoundError } from '../src/errors.js';

describe('addComment', () => {
  it('appends a comment activity with given actor and body; status unchanged; updatedAt bumped', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const fixedTs = '2030-06-01T12:00:00.000Z';

    addComment(db, task.key, { actor: 'human', body: 'looks good' }, () => fixedTs);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('backlog');
    expect(row.updated_at).toBe(fixedTs);

    const acts = recentActivity(db, task.id, 10);
    const comment = acts.find(a => a.type === 'comment');
    expect(comment).toBeDefined();
    expect(comment!.actor).toBe('human');
    expect(comment!.body).toBe('looks good');
  });

  it('returns the created Activity with correct fields', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const fixedTs = '2030-06-02T09:00:00.000Z';

    const activity = addComment(db, task.key, { actor: 'agent', body: 'done' }, () => fixedTs);

    expect(activity.type).toBe('comment');
    expect(activity.actor).toBe('agent');
    expect(activity.body).toBe('done');
    expect(activity.createdAt).toBe(fixedTs);
    expect(activity.taskId).toBe(task.id);
  });

  it('succeeds on a done task; status stays done', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='done' WHERE key=?").run(task.key);

    expect(() =>
      addComment(db, task.key, { actor: 'human', body: 'archived' }, () => '2030-01-01T00:00:00.000Z')
    ).not.toThrow();

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('done');
  });

  it('empty body throws ValidationError and writes nothing', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const before = recentActivity(db, task.id, 100).length;

    expect(() =>
      addComment(db, task.key, { actor: 'human', body: '   ' })
    ).toThrow(ValidationError);

    const after = recentActivity(db, task.id, 100).length;
    expect(after).toBe(before);
  });

  it('whitespace-only body throws ValidationError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect(() =>
      addComment(db, task.key, { actor: 'agent', body: '\t\n ' })
    ).toThrow(ValidationError);
  });

  it('unknown key throws NotFoundError', () => {
    const db = makeTestDb();

    expect(() =>
      addComment(db, 'AF-9999', { actor: 'human', body: 'hello' })
    ).toThrow(NotFoundError);
  });
});
