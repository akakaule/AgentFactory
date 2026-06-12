import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const tables = (db: any) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);

describe('runMigrations', () => {
  it('creates task, activity and link tables and is idempotent', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'link', 'task', 'workspace']));
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 });
    runMigrations(db); // second run is a no-op
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 6 });
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

  it('enforces the status CHECK constraint', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,created_at,updated_at) VALUES ('X','t','s','a','nonsense',1,'2026-01-01','2026-01-01')"
    ).run()).toThrow();
  });
});
