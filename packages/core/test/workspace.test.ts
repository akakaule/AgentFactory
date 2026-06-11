import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { SCHEMA_SQL } from '../src/schema.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { listWorkspaces } from '../src/ops/listWorkspaces.js';
import { createTask } from '../src/ops/createTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { getTask } from '../src/ops/getTask.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { getVersion } from '../src/version.js';
import { NotFoundError, ValidationError } from '../src/errors.js';

const queue = (db: ReturnType<typeof makeTestDb>, key: string) => updateStatus(db, key, 'queued', 'human');

describe('migration #2: workspace table + task.workspace_id', () => {
  it('fresh DB: user_version=2, seeded default workspace with id=1 and repo_path "."', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
    const rows = db.prepare('SELECT * FROM workspace').all() as Array<{ id: number; name: string; repo_path: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: 1, name: 'default', repo_path: '.' });
  });

  it('v1 DB with existing tasks: migrates in place, tasks backfilled to workspace_id=1', () => {
    const db = openDb(':memory:');
    // simulate a v1 database: only migration #1 applied, one pre-existing task
    db.exec('BEGIN'); db.exec(SCHEMA_SQL); db.exec('PRAGMA user_version = 1'); db.exec('COMMIT');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,created_at,updated_at) VALUES ('AF-1','t','s','a','backlog',1,'2026-01-01','2026-01-01')"
    ).run();
    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
    expect(db.prepare('SELECT workspace_id FROM task WHERE key = ?').get('AF-1')).toMatchObject({ workspace_id: 1 });
  });

  it('re-running runMigrations is a no-op', () => {
    const db = makeTestDb();
    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 5 });
    expect(db.prepare('SELECT count(*) c FROM workspace').get()).toMatchObject({ c: 1 });
  });
});

describe('createWorkspace / listWorkspaces', () => {
  it('creates a workspace and lists it alongside default', () => {
    const db = makeTestDb();
    const ws = createWorkspace(db, { name: 'shopfloor', repoPath: 'c:\\Git\\Shopfloor' });
    expect(ws).toMatchObject({ name: 'shopfloor', repoPath: 'c:\\Git\\Shopfloor' });
    expect(typeof ws.id).toBe('number');
    expect(new Date(ws.createdAt).toISOString()).toBe(ws.createdAt);
    expect(listWorkspaces(db).map((w) => w.name)).toEqual(['default', 'shopfloor']);
  });

  it('rejects a duplicate name with ValidationError', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/x' });
    expect(() => createWorkspace(db, { name: 'repo-a', repoPath: '/y' })).toThrow(ValidationError);
  });

  it.each(['My Repo', '', 'UPPER', '-leading', 'a'.repeat(65)])('rejects invalid slug %j', (name) => {
    const db = makeTestDb();
    expect(() => createWorkspace(db, { name, repoPath: '/x' })).toThrow(ValidationError);
  });

  it('rejects empty repoPath with ValidationError', () => {
    const db = makeTestDb();
    expect(() => createWorkspace(db, { name: 'ok', repoPath: '  ' })).toThrow(ValidationError);
  });
});

describe('createTask with workspace', () => {
  it('defaults to the default workspace; payload carries workspace slug', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(task.workspace).toBe('default');
  });

  it('honors an explicit workspace', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-b', repoPath: '/b' });
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'repo-b' });
    expect(task.workspace).toBe('repo-b');
  });

  it('rejects an unknown workspace slug with NotFoundError and writes nothing', () => {
    const db = makeTestDb();
    expect(() => createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'nope' })).toThrow(NotFoundError);
    expect(db.prepare('SELECT count(*) c FROM task').get()).toMatchObject({ c: 0 });
  });
});

describe('scoped claiming + filtered listing', () => {
  function seedTwoWorkspaces(db: ReturnType<typeof makeTestDb>) {
    createWorkspace(db, { name: 'a', repoPath: '/a' });
    createWorkspace(db, { name: 'b', repoPath: '/b' });
    const a1 = createTask(db, { title: 'A1', spec: 's', acceptanceCriteria: 'a', workspace: 'a' });
    const b1 = createTask(db, { title: 'B1', spec: 's', acceptanceCriteria: 'a', workspace: 'b' });
    const a2 = createTask(db, { title: 'A2', spec: 's', acceptanceCriteria: 'a', workspace: 'a' });
    queue(db, a1.key); queue(db, b1.key); queue(db, a2.key);
    return { a1, b1, a2 };
  }

  it('claim scoped to a workspace receives only its tasks, FIFO', () => {
    const db = makeTestDb();
    const { a1, a2 } = seedTwoWorkspaces(db);
    expect(claimNextTask(db, { workspace: 'a' })?.key).toBe(a1.key);
    expect(claimNextTask(db, { workspace: 'a' })?.key).toBe(a2.key);
    expect(claimNextTask(db, { workspace: 'a' })).toBeNull(); // b1 still queued, never claimed by 'a'
  });

  it('unscoped claim stays global FIFO', () => {
    const db = makeTestDb();
    const { a1 } = seedTwoWorkspaces(db);
    expect(claimNextTask(db)?.key).toBe(a1.key);
  });

  it('claim with empty scoped queue returns null even though other workspaces have work', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'a', repoPath: '/a' });
    createWorkspace(db, { name: 'b', repoPath: '/b' });
    const b1 = createTask(db, { title: 'B1', spec: 's', acceptanceCriteria: 'a', workspace: 'b' });
    queue(db, b1.key);
    expect(claimNextTask(db, { workspace: 'a' })).toBeNull();
  });

  it('claim and list with an unknown slug throw NotFoundError', () => {
    const db = makeTestDb();
    expect(() => claimNextTask(db, { workspace: 'nope' })).toThrow(NotFoundError);
    expect(() => listTasks(db, { workspace: 'nope' })).toThrow(NotFoundError);
  });

  it('listTasks filters by workspace, composable with status', () => {
    const db = makeTestDb();
    const { a1, b1, a2 } = seedTwoWorkspaces(db);
    expect(listTasks(db, { workspace: 'a' }).map((t) => t.key)).toEqual([a1.key, a2.key]);
    expect(listTasks(db, { workspace: 'b' }).map((t) => t.key)).toEqual([b1.key]);
    claimNextTask(db, { workspace: 'a' });
    expect(listTasks(db, { workspace: 'a', status: 'queued' }).map((t) => t.key)).toEqual([a2.key]);
    expect(listTasks(db).map((t) => t.key)).toEqual([a1.key, b1.key, a2.key]);
  });
});

describe('TaskDetail.repoPath + version', () => {
  it('claimed and fetched detail carry workspace + repoPath', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-c', repoPath: '/c' });
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', workspace: 'repo-c' });
    queue(db, t.key);
    const claimed = claimNextTask(db, { workspace: 'repo-c' });
    expect(claimed).toMatchObject({ key: t.key, workspace: 'repo-c', repoPath: '/c', status: 'in_progress' });
    expect(getTask(db, t.key)).toMatchObject({ workspace: 'repo-c', repoPath: '/c' });
  });

  it('default workspace detail has repoPath "."', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(getTask(db, t.key).repoPath).toBe('.');
  });

  it('creating a workspace bumps getVersion()', () => {
    const db = makeTestDb();
    const before = getVersion(db);
    createWorkspace(db, { name: 'bump', repoPath: '/x' }, () => '9999-01-01T00:00:00.000Z');
    const after = getVersion(db);
    expect(after).not.toBe(before);
    expect(after > before).toBe(true);
  });
});
