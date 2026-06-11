import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { Status, Actor } from '../src/types.js';

const FIXED_TS = '2030-08-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

describe('updateStatus', () => {
  // ── Allowed edges ──────────────────────────────────────────────────────────

  it('backlog → queued (human): status set, status_change appended, updatedAt bumped, TaskDetail returned', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    // task starts as backlog — no raw seed needed

    const detail = updateStatus(db, task.key, 'queued', 'human', fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.updatedAt).toBe(FIXED_TS);
    expect(detail.key).toBe(task.key);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
    expect(row.updated_at).toBe(FIXED_TS);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'queued');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('human');
    expect(act!.fromStatus).toBe('backlog');
    expect(act!.toStatus).toBe('queued');
    expect(act!.createdAt).toBe(FIXED_TS);
  });

  it('in_progress → blocked (agent): status set, status_change appended', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_progress' WHERE key=?").run(task.key);

    const detail = updateStatus(db, task.key, 'blocked', 'agent', fixedNow);

    expect(detail.status).toBe('blocked');
    expect(detail.updatedAt).toBe(FIXED_TS);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'blocked');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('agent');
    expect(act!.fromStatus).toBe('in_progress');
  });

  it('blocked → in_progress (agent): status set, status_change appended', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='blocked' WHERE key=?").run(task.key);

    const detail = updateStatus(db, task.key, 'in_progress', 'agent', fixedNow);

    expect(detail.status).toBe('in_progress');
    expect(detail.updatedAt).toBe(FIXED_TS);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'in_progress');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('agent');
    expect(act!.fromStatus).toBe('blocked');
  });

  it('blocked → queued (human): status set, status_change appended', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='blocked' WHERE key=?").run(task.key);

    const detail = updateStatus(db, task.key, 'queued', 'human', fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.updatedAt).toBe(FIXED_TS);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'queued');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('human');
    expect(act!.fromStatus).toBe('blocked');
  });

  it('done → queued (human): reopen clears stale claim metadata and logs the move', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    // a finished task keeps its last claimant as provenance — reopen must clear it
    db.prepare("UPDATE task SET status='done', claimed_by='worker-1', claimed_at='2030-07-31T09:00:00.000Z' WHERE key=?").run(task.key);

    const detail = updateStatus(db, task.key, 'queued', 'human', fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.claimedBy).toBeNull();
    expect(detail.claimedAt).toBeNull();

    const act = detail.activity.find(a => a.type === 'status_change' && a.fromStatus === 'done');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('human');
    expect(act!.toStatus).toBe('queued');
  });

  // ── Invalid edges (wrong transition, nothing changed) ─────────────────────

  it.each<[Status, Status, Actor]>([
    ['backlog',     'in_progress', 'human'],
    ['queued',      'done',        'human'],
    ['in_progress', 'done',        'agent'],
    ['backlog',     'done',        'agent'],
  ])('rejects %s → %s (%s): InvalidTransitionError, nothing changed', (from, to, actor) => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare('UPDATE task SET status=? WHERE key=?').run(from, task.key);

    const activityBefore = recentActivity(db, task.id, 100).length;

    expect(() => updateStatus(db, task.key, to, actor, fixedNow)).toThrow(InvalidTransitionError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe(from);
    expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
  });

  // ── Wrong actor on otherwise-valid edges ──────────────────────────────────

  it('queued → in_progress with actor human: InvalidTransitionError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='queued' WHERE key=?").run(task.key);

    expect(() => updateStatus(db, task.key, 'in_progress', 'human', fixedNow)).toThrow(InvalidTransitionError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
  });

  it('done → queued with actor agent: InvalidTransitionError (reopen is human-only)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='done' WHERE key=?").run(task.key);

    expect(() => updateStatus(db, task.key, 'queued', 'agent', fixedNow)).toThrow(InvalidTransitionError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('done');
  });

  it('in_review → done with actor agent: InvalidTransitionError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    expect(() => updateStatus(db, task.key, 'done', 'agent', fixedNow)).toThrow(InvalidTransitionError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('in_review');
  });

  // ── Unknown key ───────────────────────────────────────────────────────────

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();

    expect(() => updateStatus(db, 'AF-9999', 'queued', 'human', fixedNow)).toThrow(NotFoundError);
  });
});
