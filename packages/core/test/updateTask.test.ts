import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateTask } from '../src/ops/updateTask.js';
import { ValidationError, NotFoundError, InvalidTransitionError } from '../src/errors.js';

const FIXED_NOW = '2099-01-01T00:00:00.000Z';
const fixedNow = () => FIXED_NOW;

describe('updateTask', () => {
  it('edits only title; other fields unchanged', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'Original Title', spec: 'Spec', acceptanceCriteria: 'AC' });

    const updated = updateTask(db, original.key, { title: 'New Title' });

    expect(updated.title).toBe('New Title');
    expect(updated.spec).toBe('Spec');
    expect(updated.acceptanceCriteria).toBe('AC');
    expect(updated.status).toBe('backlog');
    expect(updated.key).toBe(original.key);
    expect(updated.id).toBe(original.id);
  });

  it('edits all three fields at once', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const updated = updateTask(db, original.key, {
      title: 'New Title',
      spec: 'New Spec',
      acceptanceCriteria: 'New AC',
    });

    expect(updated.title).toBe('New Title');
    expect(updated.spec).toBe('New Spec');
    expect(updated.acceptanceCriteria).toBe('New AC');
  });

  it('moves a backlog task to another workspace', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-b', repoPath: '/repo-b' });
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const updated = updateTask(db, original.key, { workspace: 'repo-b' }, fixedNow);

    expect(updated.workspace).toBe('repo-b');
    expect(updated.updatedAt).toBe(FIXED_NOW);
    expect(updated.title).toBe(original.title);
    expect(updated.spec).toBe(original.spec);
    expect(updated.acceptanceCriteria).toBe(original.acceptanceCriteria);
  });

  it('rejects an unknown target workspace without moving the task', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const before = db.prepare('SELECT title, workspace_id, updated_at FROM task WHERE id = ?').get(original.id);

    expect(() => updateTask(db, original.key, { title: 'Must not stick', workspace: 'missing' })).toThrow(NotFoundError);
    expect(db.prepare('SELECT title, workspace_id, updated_at FROM task WHERE id = ?').get(original.id)).toEqual(before);
  });

  it('rejects moving a task after it leaves the backlog', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-b', repoPath: '/repo-b' });
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status = 'queued' WHERE id = ?").run(original.id);

    expect(() => updateTask(db, original.key, { workspace: 'repo-b' })).toThrow(InvalidTransitionError);
    const row = db.prepare('SELECT workspace_id FROM task WHERE id = ?').get(original.id) as { workspace_id: number };
    expect(row.workspace_id).toBe(1);
  });

  it('bumps updatedAt but createdAt is unchanged', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const updated = updateTask(db, original.key, { title: 'Updated' }, fixedNow);

    expect(updated.updatedAt).toBe(FIXED_NOW);
    expect(updated.createdAt).toBe(original.createdAt);
    expect(updated.createdAt).not.toBe(FIXED_NOW);
  });

  it('rejects non-backlog task with InvalidTransitionError and does NOT modify the row', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status = ? WHERE key = ?").run('queued', original.key);

    expect(() => updateTask(db, original.key, { title: 'X' })).toThrow(InvalidTransitionError);

    // Row should be unmodified (title still 'T')
    const row = db.prepare('SELECT * FROM task WHERE key = ?').get(original.key) as { title: string; status: string };
    expect(row.title).toBe('T');
    expect(row.status).toBe('queued');
  });

  it('rejects empty payload {} with ValidationError', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect(() => updateTask(db, original.key, {})).toThrow(ValidationError);
  });

  it('rejects unknown key with NotFoundError', () => {
    const db = makeTestDb();

    expect(() => updateTask(db, 'AF-999', { title: 'X' })).toThrow(NotFoundError);
  });

  it('does NOT write an activity row', () => {
    const db = makeTestDb();
    const original = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const countBefore = (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(original.id) as { c: number }).c;
    updateTask(db, original.key, { title: 'Updated' });
    const countAfter = (db.prepare('SELECT count(*) as c FROM activity WHERE task_id = ?').get(original.id) as { c: number }).c;

    expect(countAfter).toBe(countBefore);
  });
});
