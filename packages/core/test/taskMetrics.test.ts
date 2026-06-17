import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { SCHEMA_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL } from '../src/schema.js';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { deleteTask } from '../src/ops/deleteTask.js';
import { getTask } from '../src/ops/getTask.js';
import { analyticsRows } from '../src/ops/analyticsRows.js';
import { getVersion } from '../src/version.js';
import { NotFoundError, ValidationError } from '../src/errors.js';

const claimed = (db: ReturnType<typeof makeTestDb>) => {
  const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, task.key, 'queued', 'human');
  claimNextTask(db, { claimedBy: 'worker-1' });
  return task;
};

describe('migration #4', () => {
  it('fresh DB → user_version 11 with the task_metric table', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 });
    expect(() => db.prepare('SELECT COUNT(*) n FROM task_metric').get()).not.toThrow();
  });

  it('migrates a v3 DB in place; re-run is a no-op', () => {
    const db = openDb(':memory:');
    db.exec('BEGIN');
    db.exec(SCHEMA_SQL);
    db.exec(MIGRATION_2_SQL);
    db.prepare('INSERT INTO workspace(name, repo_path, created_at) VALUES (?, ?, ?)').run('default', '.', '1970-01-01T00:00:00.000Z');
    db.exec(MIGRATION_3_SQL);
    db.exec('PRAGMA user_version = 3');
    db.exec('COMMIT');

    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 });
    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 12 });
  });
});

describe('addTaskMetrics', () => {
  it('stores a report and surfaces the aggregate on detail + analytics', () => {
    const db = makeTestDb();
    const task = claimed(db);

    addTaskMetrics(db, task.key, { model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92, reportedBy: 'wrapper' });

    const detail = getTask(db, task.key);
    expect(detail.metrics).toMatchObject({ model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92 });
    expect(analyticsRows(db).tasks[0]).toMatchObject({ model: 'claude-fable-5', tokensIn: 41000, tokensOut: 9000, costUsd: 0.92 });
  });

  it('sums tokens/cost across reports; latest model wins', () => {
    const db = makeTestDb();
    const task = claimed(db);

    addTaskMetrics(db, task.key, { model: 'claude-haiku-4-5', tokensIn: 10000, tokensOut: 2000, costUsd: 0.10 });
    addTaskMetrics(db, task.key, { model: 'claude-fable-5', tokensIn: 30000, tokensOut: 5000, costUsd: 0.80 });

    expect(getTask(db, task.key).metrics).toMatchObject({
      model: 'claude-fable-5', tokensIn: 40000, tokensOut: 7000, costUsd: 0.9,
    });
  });

  it('unreported tasks stay null (never zero)', () => {
    const db = makeTestDb();
    const task = claimed(db);
    expect(getTask(db, task.key).metrics).toMatchObject({ model: null, tokensIn: null, tokensOut: null, costUsd: null });
  });

  it('rejects an empty report and unknown keys', () => {
    const db = makeTestDb();
    const task = claimed(db);
    expect(() => addTaskMetrics(db, task.key, {})).toThrow(ValidationError);
    expect(() => addTaskMetrics(db, task.key, { reportedBy: 'wrapper' })).toThrow(ValidationError);
    expect(() => addTaskMetrics(db, 'AF-9999', { tokensIn: 1 })).toThrow(NotFoundError);
  });

  it('bumps the version so SSE consumers refresh', () => {
    const db = makeTestDb();
    const task = claimed(db);
    const before = getVersion(db);
    addTaskMetrics(db, task.key, { tokensIn: 5 }, () => '2099-01-01T00:00:00.000Z');
    expect(getVersion(db)).not.toBe(before);
  });

  it('metric rows cascade away with the task', () => {
    const db = makeTestDb();
    const task = claimed(db);
    addTaskMetrics(db, task.key, { tokensIn: 5 });
    updateStatus(db, task.key, 'queued', 'human'); // release so delete is allowed
    deleteTask(db, task.key);
    expect((db.prepare('SELECT COUNT(*) n FROM task_metric').get() as { n: number }).n).toBe(0);
  });
});
