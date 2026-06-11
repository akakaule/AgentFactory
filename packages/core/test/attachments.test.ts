import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { SCHEMA_SQL, MIGRATION_2_SQL, MIGRATION_3_SQL, MIGRATION_4_SQL } from '../src/schema.js';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { addAttachment } from '../src/ops/addAttachment.js';
import { deleteAttachment } from '../src/ops/deleteAttachment.js';
import { getAttachment } from '../src/ops/getAttachment.js';
import { getTask } from '../src/ops/getTask.js';
import { deleteTask } from '../src/ops/deleteTask.js';
import { getVersion } from '../src/version.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');
const report = { filename: 'shot.png', mime: 'image/png', dataBase64: PNG_B64 };

describe('migration #5', () => {
  it('fresh DB → user_version 5 with the attachment table', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
    expect(() => db.prepare('SELECT COUNT(*) n FROM attachment').get()).not.toThrow();
  });

  it('migrates a v4 DB in place; re-run is a no-op', () => {
    const db = openDb(':memory:');
    db.exec('BEGIN');
    db.exec(SCHEMA_SQL);
    db.exec(MIGRATION_2_SQL);
    db.prepare('INSERT INTO workspace(name, repo_path, created_at) VALUES (?, ?, ?)').run('default', '.', '1970-01-01T00:00:00.000Z');
    db.exec(MIGRATION_3_SQL);
    db.exec(MIGRATION_4_SQL);
    db.exec('PRAGMA user_version = 4');
    db.exec('COMMIT');

    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
  });
});

describe('addAttachment / getAttachment', () => {
  it('stores a pasted image and round-trips the exact bytes', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    const meta = addAttachment(db, task.key, report);
    expect(meta).toMatchObject({ filename: 'shot.png', mime: 'image/png', size: PNG_BYTES.length });

    const stored = getAttachment(db, meta.id);
    expect(stored.mime).toBe('image/png');
    expect(Buffer.from(stored.bytes).equals(Buffer.from(PNG_BYTES))).toBe(true);
  });

  it('surfaces metadata on the task detail', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addAttachment(db, task.key, report);

    const detail = getTask(db, task.key);
    expect(detail.attachments).toHaveLength(1);
    expect(detail.attachments[0]).toMatchObject({ filename: 'shot.png', mime: 'image/png', size: PNG_BYTES.length });
  });

  it('bumps the task version so the board reflects the change', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, () => '2026-01-01T00:00:00.000Z');
    const before = getVersion(db);
    addAttachment(db, task.key, report, () => '2026-02-01T00:00:00.000Z');
    expect(getVersion(db)).not.toBe(before);
  });

  it('rejects non-image mimes, oversized payloads, and empty data', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect(() => addAttachment(db, task.key, { ...report, mime: 'application/pdf' })).toThrow(ValidationError);
    const big = Buffer.alloc(4 * 1024 * 1024 + 1).toString('base64');
    expect(() => addAttachment(db, task.key, { ...report, dataBase64: big })).toThrow(ValidationError);
    expect(() => addAttachment(db, task.key, { ...report, dataBase64: '' })).toThrow(ValidationError);
  });

  it('is backlog-only: the brief is frozen once queued', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, task.key, 'queued', 'human');
    expect(() => addAttachment(db, task.key, report)).toThrow(InvalidTransitionError);
  });

  it('unknown task / attachment → NotFoundError', () => {
    const db = makeTestDb();
    expect(() => addAttachment(db, 'AF-9999', report)).toThrow(NotFoundError);
    expect(() => getAttachment(db, 12345)).toThrow(NotFoundError);
  });
});

describe('deleteAttachment', () => {
  it('removes the attachment (backlog-only)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const meta = addAttachment(db, task.key, report);

    deleteAttachment(db, meta.id);
    expect(() => getAttachment(db, meta.id)).toThrow(NotFoundError);
    expect(getTask(db, task.key).attachments).toHaveLength(0);
  });

  it('rejects deletion once the task left backlog', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    const meta = addAttachment(db, task.key, report);
    updateStatus(db, task.key, 'queued', 'human');
    expect(() => deleteAttachment(db, meta.id)).toThrow(InvalidTransitionError);
  });

  it('attachment bytes cascade away with the task', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    addAttachment(db, task.key, report);

    deleteTask(db, task.key);
    expect((db.prepare('SELECT COUNT(*) n FROM attachment').get() as { n: number }).n).toBe(0);
  });
});
