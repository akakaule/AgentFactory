import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { findByKey } from '../src/repo/tasks.js';
import { ValidationError } from '../src/errors.js';

describe('createTask', () => {
  it('creates a task in backlog with title/spec/acceptanceCriteria persisted and returns a Task', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'My Task', spec: 'Do the thing', acceptanceCriteria: 'Thing is done' });

    expect(task.status).toBe('backlog');
    expect(task.title).toBe('My Task');
    expect(task.spec).toBe('Do the thing');
    expect(task.acceptanceCriteria).toBe('Thing is done');
    expect(task.resultSummary).toBe(null);
    expect(typeof task.id).toBe('number');
    expect(typeof task.key).toBe('string');

    // Verify persisted by reading back
    const fetched = findByKey(db, task.key);
    expect(fetched).not.toBeNull();
    expect(fetched!.title).toBe('My Task');
    expect(fetched!.spec).toBe('Do the thing');
    expect(fetched!.acceptanceCriteria).toBe('Thing is done');
    expect(fetched!.status).toBe('backlog');
  });

  it('assigns keys AF-1 then AF-2; seq equals the numeric id and increases', () => {
    const db = makeTestDb();
    const t1 = createTask(db, { title: 'Task 1', spec: 'Spec 1', acceptanceCriteria: 'AC 1' });
    const t2 = createTask(db, { title: 'Task 2', spec: 'Spec 2', acceptanceCriteria: 'AC 2' });

    expect(t1.key).toBe('AF-1');
    expect(t2.key).toBe('AF-2');
    expect(t1.seq).toBe(t1.id);
    expect(t2.seq).toBe(t2.id);
    expect(t2.seq).toBeGreaterThan(t1.seq);
  });

  it('createdAt === updatedAt and both are valid ISO strings', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect(task.createdAt).toBe(task.updatedAt);
    expect(new Date(task.createdAt).toISOString()).toBe(task.createdAt);
    expect(new Date(task.updatedAt).toISOString()).toBe(task.updatedAt);
  });

  it('writes exactly ONE activity row: type=status_change, actor=human, from_status IS NULL, to_status=backlog', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const rows = db.prepare('SELECT * FROM activity WHERE task_id = ?').all(task.id) as Array<{
      type: string; actor: string; from_status: string | null; to_status: string | null; created_at: string;
    }>;

    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe('status_change');
    expect(rows[0].actor).toBe('human');
    expect(rows[0].from_status).toBeNull();
    expect(rows[0].to_status).toBe('backlog');
    expect(rows[0].created_at).toBe(task.createdAt);
  });

  it('attributes the seed activity to the caller-supplied actor (agent), defaulting to human', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', actor: 'agent' });
    const row = db.prepare('SELECT actor FROM activity WHERE task_id = ?').get(task.id) as { actor: string };
    expect(row.actor).toBe('agent');
    expect(task.status).toBe('backlog'); // agent-filed tasks still land in backlog, never queued
  });

  it('defaults stage to implementation (back-compat: clients opt into the pipeline explicitly)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(task.stage).toBe('implementation');
    expect(findByKey(db, task.key)!.stage).toBe('implementation');
  });

  it('persists an explicit stage and lets acceptanceCriteria default at the description stage', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'Raw idea', stage: 'description' });
    expect(task.stage).toBe('description');
    expect(task.acceptanceCriteria).toBe('To be defined by the description stage.');
  });

  it('accepts explicit acceptanceCriteria at the description stage', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'description' });
    expect(task.acceptanceCriteria).toBe('A');
  });

  it('rejects a missing acceptanceCriteria unless the stage is description', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: 'S' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: 'T', spec: 'S', stage: 'implementation' })).toThrow(ValidationError);
    expect(() => createTask(db, { title: 'T', spec: 'S', stage: 'plan' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects an unknown stage with ValidationError', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'review' as never })).toThrow(ValidationError);
  });

  it('rejects empty title with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: '', spec: 'S', acceptanceCriteria: 'A' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects whitespace-only title with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: '   ', spec: 'S', acceptanceCriteria: 'A' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects empty spec with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: '', acceptanceCriteria: 'A' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects whitespace-only spec with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: '   ', acceptanceCriteria: 'A' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects empty acceptanceCriteria with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: '' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('rejects whitespace-only acceptanceCriteria with ValidationError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: '   ' })).toThrow(ValidationError);
    const count = (db.prepare('SELECT count(*) as c FROM task').get() as { c: number }).c;
    expect(count).toBe(0);
  });
});
