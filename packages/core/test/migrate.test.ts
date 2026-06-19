import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const tables = (db: any) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);

describe('runMigrations', () => {
  it('creates task, activity and link tables and is idempotent', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'link', 'task', 'workspace', 'app_user', 'api_token', 'agent_session', 'supervisor_heartbeat', 'app_kv']));
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 14 });
    runMigrations(db); // second run is a no-op
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 14 });
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

  it('migration #10 adds agent_session with a partial-unique live index (one live row per task)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['agent_session']));
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','in_progress',1,1,'2026-01-01','2026-01-01')"
    ).run();
    const tid = (db.prepare("SELECT id FROM task WHERE key='AF-1'").get() as { id: number }).id;
    const ins = "INSERT INTO agent_session(task_id, workspace, stage, started_at, heartbeat_at) VALUES (?, 'default', 'implementation', '2026-01-01', '2026-01-01')";
    db.prepare(ins).run(tid);
    expect(() => db.prepare(ins).run(tid)).toThrow(); // a second LIVE row for the task is rejected
    db.prepare("UPDATE agent_session SET ended_at='2026-01-02' WHERE task_id=?").run(tid);
    expect(() => db.prepare(ins).run(tid)).not.toThrow(); // ending the first frees the slot
  });

  it('migration #11 adds nullable original_spec / original_acceptance_criteria columns', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('original_spec');
    expect(cols).toContain('original_acceptance_criteria');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','queued',1,1,'2026-01-01','2026-01-01')"
    ).run();
    expect(db.prepare('SELECT original_spec, original_acceptance_criteria FROM task WHERE key = ?').get('AF-1'))
      .toMatchObject({ original_spec: null, original_acceptance_criteria: null });
  });

  it('migration #13 adds supervisor_heartbeat (name PK, kind CHECK) and app_kv', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['supervisor_heartbeat', 'app_kv']));
    db.prepare(
      "INSERT INTO supervisor_heartbeat(name,kind,workspaces,in_flight,capacity,started_at,last_seen_at) VALUES ('d','dispatcher','default',0,1,'2026-01-01','2026-01-01')"
    ).run();
    // the kind CHECK rejects anything but dispatcher/reviewer
    expect(() => db.prepare(
      "INSERT INTO supervisor_heartbeat(name,kind,started_at,last_seen_at) VALUES ('x','nonsense','2026-01-01','2026-01-01')"
    ).run()).toThrow();
    // app_kv is a simple key/value store
    db.prepare("INSERT INTO app_kv(key,value) VALUES ('notify_cursor','42')").run();
    expect(db.prepare("SELECT value FROM app_kv WHERE key='notify_cursor'").get()).toMatchObject({ value: '42' });
  });

  it('migration #14 re-adds original_spec columns on a DB that diverged past migration #11', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    // Simulate a DB that was migrated by a parallel branch whose #11 added a different column:
    // the original_spec columns are absent, yet user_version already advanced past 11. Migration
    // #14 must re-add them idempotently rather than skip (user_version is already >= 11).
    db.exec('ALTER TABLE task DROP COLUMN original_spec');
    db.exec('ALTER TABLE task DROP COLUMN original_acceptance_criteria');
    db.exec('PRAGMA user_version = 13');
    runMigrations(db);
    const cols = (db.prepare("PRAGMA table_info('task')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('original_spec');
    expect(cols).toContain('original_acceptance_criteria');
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 14 });
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
