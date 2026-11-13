import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';
import { createCore } from '../src/index.js';
import { createApiToken, authenticateToken, createUser } from '../src/ops/auth.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { getTask } from '../src/ops/getTask.js';
import { expectedRevisionOf } from '../src/ops/approval.js';
import { ValidationError } from '../src/errors.js';
import { hashToken } from '../src/token.js';
import type { DB } from '../src/db.js';

const tokenCount = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM api_token').get() as { n: number }).n;
const fixedNow = () => '2030-09-01T10:00:00.000Z';

describe('delegate tokens', () => {
  it('mints a delegate token bound to its user (AC1)', () => {
    const db = makeTestDb();
    const u = createUser(db, { email: 'alvin@example.com', displayName: 'Alvin' });
    const minted = createApiToken(db, { label: 'Claude Code', userId: u.id, delegate: true });
    expect(minted.delegate).toBe(true);
    const authed = authenticateToken(db, minted.token)!;
    expect(authed.userId).toBe(u.id);
    expect(authed.delegate).toBe(true);
    expect(authed.label).toBe('Claude Code');
  });

  it('plain user, service and supervisor tokens authenticate with delegate false', () => {
    const db = makeTestDb();
    const u = createUser(db, { email: 'alvin@example.com' });
    expect(authenticateToken(db, createApiToken(db, { label: 'u', userId: u.id }).token)!.delegate).toBe(false);
    expect(authenticateToken(db, createApiToken(db, { label: 's', isService: true }).token)!.delegate).toBe(false);
    expect(authenticateToken(db, createApiToken(db, { label: 'v', isService: true, isSupervisor: true }).token)!.delegate).toBe(false);
  });

  it('refuses a delegate without a user, or with a service/supervisor capability, inserting no row (AC1)', () => {
    const db = makeTestDb();
    const u = createUser(db, { email: 'alvin@example.com' });
    const before = tokenCount(db);
    expect(() => createApiToken(db, { label: 'x', userId: null, delegate: true })).toThrow(ValidationError);
    expect(() => createApiToken(db, { label: 'x', delegate: true })).toThrow(ValidationError);
    expect(() => createApiToken(db, { label: 'x', userId: u.id, isService: true, delegate: true })).toThrow(ValidationError);
    expect(() => createApiToken(db, { label: 'x', userId: u.id, isSupervisor: true, delegate: true })).toThrow(ValidationError);
    expect(tokenCount(db)).toBe(before);
  });

  it('records actor_delegate on an approve and serves it via getTask; a plain user approve stays null (AC5, AC7)', () => {
    const db = makeTestDb();
    const u = createUser(db, { email: 'alvin@example.com', displayName: 'Alvin' });
    const a = createTask(db, { title: 'A', spec: 'S', acceptanceCriteria: 'A' });
    const b = createTask(db, { title: 'B', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key IN (?, ?)").run(a.key, b.key);

    reviewApprove(db, a.key, fixedNow, u.id, undefined, undefined, expectedRevisionOf(getTask(db, a.key)), 'Claude Code');
    reviewApprove(db, b.key, fixedNow, u.id, undefined, undefined, expectedRevisionOf(getTask(db, b.key)));

    const newest = db.prepare('SELECT actor, actor_user_id, actor_delegate FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(a.id);
    expect(newest).toEqual({ actor: 'human', actor_user_id: u.id, actor_delegate: 'Claude Code' });
    const plain = db.prepare('SELECT actor_delegate FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT 1').get(b.id);
    expect(plain).toEqual({ actor_delegate: null });

    const served = getTask(db, a.key).activity.find((x) => x.type === 'status_change' && x.toStatus === 'done')!;
    expect(served.actorDelegate).toBe('Claude Code');
    expect(served.actorName).toBe('Alvin');
    const servedPlain = getTask(db, b.key).activity.find((x) => x.type === 'status_change' && x.toStatus === 'done')!;
    expect(servedPlain.actorDelegate).toBeNull();
    // rows written outside the delegate request (the creation seed) stay null
    const seed = getTask(db, a.key).activity.find((x) => x.type === 'status_change' && x.fromStatus === null)!;
    expect(seed.actorDelegate).toBeNull();
  });

  it('stamps every row a delegate request-changes writes (AC6)', () => {
    const db = makeTestDb();
    const u = createUser(db, { email: 'alvin@example.com', displayName: 'Alvin' });
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(t.key);
    const maxBefore = (db.prepare('SELECT MAX(id) AS m FROM activity').get() as { m: number }).m;

    reviewRequestChanges(db, t.key, { feedback: 'fix it', actorUserId: u.id, actorDelegate: 'Claude Code' }, fixedNow);

    const rows = db.prepare('SELECT type, actor_delegate FROM activity WHERE task_id = ? AND id > ?').all(t.id, maxBefore) as Array<{ type: string; actor_delegate: string | null }>;
    expect(rows.map((r) => r.type).sort()).toEqual(['feedback', 'status_change']);
    for (const r of rows) expect(r.actor_delegate).toBe('Claude Code');
  });

  it('migrating from head #37 keeps tokens working with delegate false and activity reading null (AC9)', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    const head = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    const core = createCore(db);
    const u = core.createUser({ email: 'alvin@example.com', displayName: 'Alvin' });
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.addComment(t.key, { actor: 'human', body: 'hi', actorUserId: u.id });
    db.exec('ALTER TABLE api_token DROP COLUMN delegate');
    db.exec('ALTER TABLE activity DROP COLUMN actor_delegate');
    db.exec('PRAGMA user_version = 37');
    expect(head).toBe(38); // exactly one migration added on top of #37

    // tokens as a #37 build wrote them (no delegate column)
    const ins = db.prepare('INSERT INTO api_token(token_hash, user_id, label, is_service, is_supervisor, created_at) VALUES (?,?,?,?,?,?)');
    ins.run(hashToken('raw-user'), u.id, 'phone', 0, 0, 'x');
    ins.run(hashToken('raw-svc'), null, 'bridge', 1, 0, 'x');
    ins.run(hashToken('raw-sup'), null, 'dispatcher', 1, 1, 'x');

    runMigrations(db);
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 38 });
    const rows = db.prepare('SELECT label, user_id, is_service, is_supervisor, delegate FROM api_token ORDER BY id').all();
    expect(rows).toEqual([
      { label: 'phone', user_id: u.id, is_service: 0, is_supervisor: 0, delegate: 0 },
      { label: 'bridge', user_id: null, is_service: 1, is_supervisor: 0, delegate: 0 },
      { label: 'dispatcher', user_id: null, is_service: 1, is_supervisor: 1, delegate: 0 },
    ]);
    expect(core.authenticateToken('raw-user')).toMatchObject({ userId: u.id, isService: false, isSupervisor: false, delegate: false });
    expect(core.authenticateToken('raw-svc')).toMatchObject({ userId: null, isService: true, isSupervisor: false, delegate: false });
    expect(core.authenticateToken('raw-sup')).toMatchObject({ userId: null, isService: true, isSupervisor: true, delegate: false });
    const activity = core.getTask(t.key).activity;
    expect(activity.length).toBeGreaterThan(1);
    for (const a of activity) expect(a.actorDelegate).toBeNull();
  });
});
