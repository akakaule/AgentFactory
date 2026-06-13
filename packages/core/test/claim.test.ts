import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { openDb, type DB } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { SCHEMA_SQL, MIGRATION_2_SQL } from '../src/schema.js';
import { createTask } from '../src/ops/createTask.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { featureBranch } from '../src/branch.js';
import { InvalidTransitionError } from '../src/errors.js';

function seedQueued(db: DB): string {
  const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, t.key, 'queued', 'human');
  return t.key;
}

const claimRow = (db: DB, key: string) =>
  db.prepare('SELECT claimed_by, claimed_at FROM task WHERE key = ?').get(key) as
    { claimed_by: string | null; claimed_at: string | null };

describe('migration #3: claim columns', () => {
  it('fresh DB → user_version 9, claim columns present and NULL', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 });
    const key = seedQueued(db);
    expect(claimRow(db, key)).toEqual({ claimed_by: null, claimed_at: null });
  });

  it('v2 DB with tasks migrates in place; claim fields NULL', () => {
    const db = openDb(':memory:');
    // simulate a v2 database: migrations #1 + #2 applied, one task present
    db.exec('BEGIN');
    db.exec(SCHEMA_SQL);
    db.exec(MIGRATION_2_SQL);
    db.prepare('INSERT INTO workspace(name, repo_path, created_at) VALUES (?, ?, ?)')
      .run('default', '.', '1970-01-01T00:00:00.000Z');
    db.exec('PRAGMA user_version = 2');
    db.exec('COMMIT');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','in_progress',1,1,'2026-01-01','2026-01-01')"
    ).run();

    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 9 });
    expect(claimRow(db, 'AF-1')).toEqual({ claimed_by: null, claimed_at: null });
  });
});

describe('claim metadata', () => {
  it('claim with claimedBy records label + timestamp on payload, DB, detail, and list rows', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    const ts = '2030-01-01T00:00:00.000Z';

    const claimed = claimNextTask(db, { claimedBy: 'worker-1' }, () => ts);
    expect(claimed).toMatchObject({ key, claimedBy: 'worker-1', claimedAt: ts });
    expect(claimRow(db, key)).toEqual({ claimed_by: 'worker-1', claimed_at: ts });
    expect(getTask(db, key)).toMatchObject({ claimedBy: 'worker-1', claimedAt: ts });
    expect(listTasks(db)[0]).toMatchObject({ claimedBy: 'worker-1', claimedAt: ts });
  });

  it('claim without a label still records claimed_at', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    const ts = '2030-01-01T00:00:00.000Z';

    const claimed = claimNextTask(db, {}, () => ts);
    expect(claimed).toMatchObject({ key, claimedBy: null, claimedAt: ts });
  });

  it('unclaimed tasks list null claim fields', () => {
    const db = makeTestDb();
    createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(listTasks(db)[0]).toMatchObject({ claimedBy: null, claimedAt: null });
  });
});

describe('branch assignment', () => {
  it('first claim computes feature/<key>-<kebab>, persists it, and reports branchCreated', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Barcode scanner intake form', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, t.key, 'queued', 'human');

    const claimed = claimNextTask(db, { claimedBy: 'worker-1' });
    const expected = featureBranch(t.key, 'Barcode scanner intake form');
    expect(claimed!.branch).toBe(expected);
    expect(claimed!.branchCreated).toBe(true);
    // persisted
    expect(db.prepare('SELECT branch FROM task WHERE key = ?').get(t.key)).toMatchObject({ branch: expected });
    expect(getTask(db, t.key).branch).toBe(expected);
  });

  it('reclaim reuses the persisted branch and reports branchCreated=false, even after a title edit', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Original title', spec: 'S', acceptanceCriteria: 'A' });
    updateStatus(db, t.key, 'queued', 'human');
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    const original = first!.branch;
    expect(original).toBe(featureBranch(t.key, 'Original title'));

    // submit → request-changes re-queues; the title changes before the reclaim
    submitResult(db, t.key, { summary: 'done' });
    reviewRequestChanges(db, t.key, { feedback: 'again' });
    db.prepare('UPDATE task SET title = ? WHERE key = ?').run('A completely different title now', t.key);

    const reclaimed = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(reclaimed!.branch).toBe(original); // stable under the title edit
    expect(reclaimed!.branchCreated).toBe(false);
  });

  it('doc-stage claims never name a branch: branch stays NULL, branchCreated=false', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Pipeline task', spec: 'Raw idea', stage: 'description' });
    updateStatus(db, t.key, 'queued', 'human');

    const claimed = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(claimed!.stage).toBe('description');
    expect(claimed!.branch).toBeNull();
    expect(claimed!.branchCreated).toBe(false);
    expect(db.prepare('SELECT branch FROM task WHERE key = ?').get(t.key)).toMatchObject({ branch: null });
  });

  it('the branch is named at the first implementation-stage claim, from the post-description title', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Raw working title', spec: 'S', stage: 'description' });
    updateStatus(db, t.key, 'queued', 'human');
    claimNextTask(db, { claimedBy: 'worker-1' });

    // simulate the doc stages completing: title refined, stage advanced, re-queued
    db.prepare("UPDATE task SET title = ?, stage = 'implementation', status = 'queued' WHERE key = ?")
      .run('Refined feature title', t.key);

    const claimed = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(claimed!.branch).toBe(featureBranch(t.key, 'Refined feature title'));
    expect(claimed!.branchCreated).toBe(true);
  });

  it('a legacy task (branch left NULL) gets a fresh branch and branchCreated=true on its next claim', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'Legacy task', spec: 'S', acceptanceCriteria: 'A' });
    // simulate a pre-feature claim: queued with no branch persisted
    updateStatus(db, t.key, 'queued', 'human');
    expect(db.prepare('SELECT branch FROM task WHERE key = ?').get(t.key)).toMatchObject({ branch: null });

    const claimed = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(claimed!.branch).toBe(featureBranch(t.key, 'Legacy task'));
    expect(claimed!.branchCreated).toBe(true);
  });
});

describe('release + clear-on-queued', () => {
  it('human releases in_progress → queued; claim fields cleared; activity written', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    const released = updateStatus(db, key, 'queued', 'human');
    expect(released).toMatchObject({ status: 'queued', claimedBy: null, claimedAt: null });
    expect(claimRow(db, key)).toEqual({ claimed_by: null, claimed_at: null });

    const last = released.activity[released.activity.length - 1]!;
    expect(last).toMatchObject({ type: 'status_change', actor: 'human', fromStatus: 'in_progress', toStatus: 'queued' });
  });

  it('an agent cannot release a claim', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, {});
    expect(() => updateStatus(db, key, 'queued', 'agent')).toThrow(InvalidTransitionError);
  });

  it('request-changes (in_review → queued) clears the claim', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });
    submitResult(db, key, { summary: 'done' });
    const requeued = reviewRequestChanges(db, key, { feedback: 'more' });
    expect(requeued).toMatchObject({ claimedBy: null, claimedAt: null });
  });

  it('blocked keeps the claim; blocked → queued clears it', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });

    const blocked = updateStatus(db, key, 'blocked', 'agent');
    expect(blocked).toMatchObject({ claimedBy: 'worker-1' });

    const requeued = updateStatus(db, key, 'queued', 'human');
    expect(requeued).toMatchObject({ claimedBy: null, claimedAt: null });
  });

  it('in_review keeps the claim as provenance', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });
    const submitted = submitResult(db, key, { summary: 'done' });
    expect(submitted).toMatchObject({ claimedBy: 'worker-1' });
  });

  it('re-claim after release overwrites metadata and the new claimant sees prior history', () => {
    const db = makeTestDb();
    const key = seedQueued(db);
    claimNextTask(db, { claimedBy: 'worker-1' });
    updateStatus(db, key, 'queued', 'human'); // release

    const reclaimed = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(reclaimed).toMatchObject({ key, claimedBy: 'worker-2' });

    // full prior history: created → queued → claimed(w1) → released → claimed(w2)
    const transitions = reclaimed!.activity.filter((a) => a.type === 'status_change');
    expect(transitions.length).toBeGreaterThanOrEqual(5);
    expect(transitions.some((a) => a.fromStatus === 'in_progress' && a.toStatus === 'queued' && a.actor === 'human')).toBe(true);
  });
});
