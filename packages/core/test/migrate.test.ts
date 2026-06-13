import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const tables = (db: any) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);

describe('runMigrations', () => {
  it('creates task, activity and link tables and is idempotent', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'link', 'task', 'workspace', 'app_user', 'api_token']));
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 });
    runMigrations(db); // second run is a no-op
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 });
  });

  it('migration #6 adds a nullable branch column (legacy rows stay NULL)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('branch');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','queued',1,1,'2026-01-01','2026-01-01')"
    ).run();
    expect(db.prepare('SELECT branch FROM task WHERE key = ?').get('AF-1')).toMatchObject({ branch: null });
  });

  it('migration #7 adds stage (default implementation) and a nullable plan column', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('stage');
    expect(cols).toContain('plan');
    // a legacy-style insert that names neither column behaves as an implementation-stage task
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','queued',1,1,'2026-01-01','2026-01-01')"
    ).run();
    expect(db.prepare('SELECT stage, plan FROM task WHERE key = ?').get('AF-1')).toMatchObject({ stage: 'implementation', plan: null });
  });

  it('migration #8 adds a nullable archived_at column (legacy rows backfill active)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('archived_at');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','done',1,1,'2026-01-01','2026-01-01')"
    ).run();
    expect(db.prepare('SELECT archived_at FROM task WHERE key = ?').get('AF-1')).toMatchObject({ archived_at: null });
  });

  it('migration #9 adds app_user + api_token, the actor_user_id column, and seeds the system user', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['app_user', 'api_token']));
    const actCols = (db.prepare("PRAGMA table_info('activity')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(actCols).toContain('actor_user_id');
    const sys = db.prepare('SELECT id, email, is_system FROM app_user WHERE id = 1').get() as { id: number; email: string; is_system: number };
    expect(sys).toMatchObject({ id: 1, email: 'system@localhost', is_system: 1 });
  });

  it('enforces the stage CHECK constraint', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,stage,seq,workspace_id,created_at,updated_at) VALUES ('X','t','s','a','queued','nonsense',1,1,'2026-01-01','2026-01-01')"
    ).run()).toThrow();
  });

  it('enforces the status CHECK constraint', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,created_at,updated_at) VALUES ('X','t','s','a','nonsense',1,'2026-01-01','2026-01-01')"
    ).run()).toThrow();
  });
});
