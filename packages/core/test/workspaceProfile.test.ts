import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createWorkspace } from '../src/ops/createWorkspace.js';
import { updateWorkspace } from '../src/ops/updateWorkspace.js';
import { listWorkspaces } from '../src/ops/listWorkspaces.js';
import { effectiveWorkspaceProfile } from '../src/workspaceProfile.js';
import { ValidationError } from '../src/errors.js';

const workspaceColumns = (db: ReturnType<typeof makeTestDb>) =>
  (db.prepare("PRAGMA table_info('workspace')").all() as Array<{ name: string }>).map((c) => c.name);
const PROFILE_COLUMNS = ['base_branch', 'required_checks', 'ci_mode'];
const dropProfileColumns = (db: ReturnType<typeof makeTestDb>) => {
  for (const c of PROFILE_COLUMNS) db.exec(`ALTER TABLE workspace DROP COLUMN ${c}`);
};

describe('workspace profile migration', () => {
  it('upgrades a current (version-28) schema: adds the profile columns, existing rows read as unset', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    dropProfileColumns(db);
    db.exec('PRAGMA user_version = 28');
    db.prepare("INSERT INTO workspace(name, repo_path, created_at, verify_command) VALUES ('old', '/old', '2026-01-01', 'npm test')").run();

    runMigrations(db);

    expect(workspaceColumns(db)).toEqual(expect.arrayContaining(PROFILE_COLUMNS));
    const old = listWorkspaces(db).find((w) => w.name === 'old')!;
    expect(old).toMatchObject({ verifyCommand: 'npm test', baseBranch: null, requiredChecks: null, ciMode: null });
  });

  it('reconciles a divergent schema: keeps a profile column (and its data) a re-slotted build already added, plus unknown columns', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    dropProfileColumns(db);
    // a re-slotted/diverged build already added base_branch and an unrelated column
    db.exec('ALTER TABLE workspace ADD COLUMN base_branch TEXT');
    db.exec('ALTER TABLE workspace ADD COLUMN origin_url TEXT');
    db.prepare("INSERT INTO workspace(name, repo_path, created_at, base_branch, origin_url) VALUES ('div', '/div', '2026-01-01', 'develop', 'https://x')").run();
    db.exec('PRAGMA user_version = 28');

    expect(() => runMigrations(db)).not.toThrow();

    expect(workspaceColumns(db)).toEqual(expect.arrayContaining([...PROFILE_COLUMNS, 'origin_url']));
    expect(db.prepare("SELECT base_branch, origin_url FROM workspace WHERE name='div'").get()).toMatchObject({ base_branch: 'develop', origin_url: 'https://x' });
    expect(listWorkspaces(db).find((w) => w.name === 'div')).toMatchObject({ baseBranch: 'develop', ciMode: null });
  });

  it('is migration #31: a fresh DB ends at user_version 31 with the profile columns', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 32 });
    expect(workspaceColumns(db)).toEqual(expect.arrayContaining(PROFILE_COLUMNS));
  });

  // Rebuild main's history up to `version`: #29 = cancelled, #30 = the revision schema (task_submission).
  const atVersion = (version: 29 | 30) => {
    const db = openDb(':memory:');
    runMigrations(db);
    dropProfileColumns(db);
    if (version === 29) {
      db.exec('DROP TABLE task_submission');
      db.exec('ALTER TABLE task_visualization DROP COLUMN submission_id');
      db.exec('ALTER TABLE task_visualization DROP COLUMN head_sha');
      for (const c of ['submission_id', 'approved_head_sha', 'head_sha']) db.exec(`ALTER TABLE task_delivery DROP COLUMN ${c}`);
    }
    db.prepare("INSERT INTO workspace(name, repo_path, created_at) VALUES ('old', '/old', '2026-01-01')").run();
    db.exec(`PRAGMA user_version = ${version}`);
    return db;
  };
  const expectUnsetProfile = (db: ReturnType<typeof makeTestDb>) => {
    expect(workspaceColumns(db)).toEqual(expect.arrayContaining(PROFILE_COLUMNS));
    const old = listWorkspaces(db).find((w) => w.name === 'old')!;
    expect(old).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
    const eff = effectiveWorkspaceProfile(old, null);
    expect(eff.requiredChecks.value).toEqual([]);
    expect(eff.ciMode.value).toBe('legacy');
  };

  it('upgrades a version-29 (cancelled, no task_submission) DB to 31 with the profile columns', () => {
    const db = atVersion(29);
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','cancelled',1,1,'2026-01-01','2026-01-01')",
    ).run();

    runMigrations(db);

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 32 });
    expectUnsetProfile(db);
    expect(db.prepare("SELECT status FROM task WHERE key='AF-1'").get()).toEqual({ status: 'cancelled' });
  });

  it('upgrades a version-30 (task_submission) DB to 31 with the profile columns, leaving submissions untouched', () => {
    const db = atVersion(30);
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','in_review',1,1,'2026-01-01','2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO task_submission(task_id,stage,revision_source,observed_at,created_at,head_sha,read_ticket_seq,last_recorded_ticket) VALUES ((SELECT id FROM task WHERE key='AF-1'),'implementation','origin','2026-01-01','2026-01-01','abc',3,2)",
    ).run();
    const before = db.prepare('SELECT * FROM task_submission ORDER BY id').all();

    runMigrations(db);

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 32 });
    expectUnsetProfile(db);
    expect(db.prepare('SELECT * FROM task_submission ORDER BY id').all()).toEqual(before);
  });

  it('upgrades a divergent version-30 DB that already has base_branch, keeping its value', () => {
    const db = atVersion(30);
    db.exec('ALTER TABLE workspace ADD COLUMN base_branch TEXT');
    db.prepare("UPDATE workspace SET base_branch = 'develop' WHERE name = 'old'").run();

    expect(() => runMigrations(db)).not.toThrow();

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 32 });
    expect(workspaceColumns(db)).toEqual(expect.arrayContaining(PROFILE_COLUMNS));
    expect(listWorkspaces(db).find((w) => w.name === 'old')).toMatchObject({ baseBranch: 'develop' });
  });

  it('re-running the migration on a rewound DB is a no-op', () => {
    const db = makeTestDb();
    const v = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    db.exec(`PRAGMA user_version = ${v - 1}`);
    expect(() => runMigrations(db)).not.toThrow();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: v });
  });

  it('bounds ci_mode with a CHECK so direct writes cannot store an unknown mode', () => {
    const db = makeTestDb();
    expect(() => db.prepare("UPDATE workspace SET ci_mode = 'sometimes' WHERE id = 1").run()).toThrow();
    expect(() => db.prepare("UPDATE workspace SET ci_mode = 'required' WHERE id = 1").run()).not.toThrow();
  });
});

describe('workspace profile fields', () => {
  it('a new workspace has no profile values', () => {
    const db = makeTestDb();
    const w = createWorkspace(db, { name: 'repo-a', repoPath: '/a' });
    expect(w).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
    expect(listWorkspaces(db).find((x) => x.name === 'repo-a')).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
  });

  it('sets, normalizes and clears baseBranch, requiredChecks and ciMode', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });
    const set = updateWorkspace(db, 'repo-a', { baseBranch: ' develop ', requiredChecks: [' build ', 'test', 'build', ''], ciMode: 'required' });
    expect(set).toMatchObject({ baseBranch: 'develop', requiredChecks: ['build', 'test'], ciMode: 'required' });
    expect(listWorkspaces(db).find((x) => x.name === 'repo-a')).toMatchObject({ baseBranch: 'develop', requiredChecks: ['build', 'test'], ciMode: 'required' });

    const cleared = updateWorkspace(db, 'repo-a', { baseBranch: null, requiredChecks: [], ciMode: null });
    expect(cleared).toMatchObject({ baseBranch: null, requiredChecks: null, ciMode: null });
  });

  it('a profile field alone satisfies the ≥1-field patch and leaves other fields untouched', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });
    updateWorkspace(db, 'repo-a', { policy: 'keep me' });
    expect(updateWorkspace(db, 'repo-a', { ciMode: 'none' })).toMatchObject({ policy: 'keep me', ciMode: 'none' });
  });

  it('rejects an unsafe base branch, an unknown ciMode and a non-string check name', () => {
    const db = makeTestDb();
    createWorkspace(db, { name: 'repo-a', repoPath: '/a' });
    for (const bad of ['-x', 'a..b', 'has space', 'a:b']) {
      expect(() => updateWorkspace(db, 'repo-a', { baseBranch: bad })).toThrow(ValidationError);
    }
    expect(() => updateWorkspace(db, 'repo-a', { ciMode: 'sometimes' as never })).toThrow(ValidationError);
    expect(() => updateWorkspace(db, 'repo-a', { requiredChecks: [42 as never] })).toThrow(ValidationError);
    expect(listWorkspaces(db).find((x) => x.name === 'repo-a')).toMatchObject({ baseBranch: null, ciMode: null });
  });
});

describe('effectiveWorkspaceProfile', () => {
  const unset = { baseBranch: null, requiredChecks: null, ciMode: null };

  it('legacy default: an unset profile is ciMode legacy, no required checks, base branch detected', () => {
    expect(effectiveWorkspaceProfile(unset, 'main')).toEqual({
      baseBranch: { value: 'main', source: 'detected' },
      requiredChecks: { value: [], source: 'default' },
      ciMode: { value: 'legacy', source: 'default' },
    });
  });

  it('an undetectable default branch is reported as unresolved, never guessed', () => {
    expect(effectiveWorkspaceProfile(unset, null).baseBranch).toEqual({ value: null, source: 'unresolved' });
  });

  it('configured values win over detection and defaults', () => {
    expect(effectiveWorkspaceProfile({ baseBranch: 'develop', requiredChecks: ['build'], ciMode: 'required' }, 'main')).toEqual({
      baseBranch: { value: 'develop', source: 'configured' },
      requiredChecks: { value: ['build'], source: 'configured' },
      ciMode: { value: 'required', source: 'configured' },
    });
  });
});
