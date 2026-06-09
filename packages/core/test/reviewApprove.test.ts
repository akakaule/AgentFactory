import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { NotFoundError, InvalidTransitionError } from '../src/errors.js';
import type { Status } from '../src/types.js';

const FIXED_TS = '2030-09-01T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

describe('reviewApprove', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('in_review → done: status set, status_change(human, in_review→done) appended, updatedAt bumped, TaskDetail returned', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewApprove(db, task.key, fixedNow);

    expect(detail.status).toBe('done');
    expect(detail.updatedAt).toBe(FIXED_TS);
    expect(detail.key).toBe(task.key);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('done');
    expect(row.updated_at).toBe(FIXED_TS);

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'done');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('human');
    expect(act!.fromStatus).toBe('in_review');
    expect(act!.toStatus).toBe('done');
    expect(act!.createdAt).toBe(FIXED_TS);
  });

  // ── Rejects non-in_review statuses ───────────────────────────────────────

  it.each<Status>(['backlog', 'queued', 'in_progress', 'done', 'blocked'])(
    'rejects from status=%s with InvalidTransitionError; nothing changed',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare('UPDATE task SET status=? WHERE key=?').run(status, task.key);

      const activityBefore = recentActivity(db, task.id, 100).length;

      expect(() => reviewApprove(db, task.key, fixedNow)).toThrow(InvalidTransitionError);

      const row = findRowByKey(db, task.key)!;
      expect(row.status).toBe(status);
      expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
    },
  );

  // ── Unknown key ───────────────────────────────────────────────────────────

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();

    expect(() => reviewApprove(db, 'AF-9999', fixedNow)).toThrow(NotFoundError);
  });
});
