import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';
import type { Status } from '../src/types.js';

const FIXED_TS = '2030-09-02T10:00:00.000Z';
const fixedNow = () => FIXED_TS;

describe('reviewRequestChanges', () => {
  // ── Happy path ────────────────────────────────────────────────────────────

  it('in_review → queued: status set, feedback + status_change appended, updatedAt bumped, TaskDetail returned with both', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewRequestChanges(db, task.key, { feedback: 'please fix the null check' }, fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.updatedAt).toBe(FIXED_TS);
    expect(detail.key).toBe(task.key);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('queued');
    expect(row.updated_at).toBe(FIXED_TS);

    const feedbackAct = detail.activity.find(a => a.type === 'feedback');
    expect(feedbackAct).toBeDefined();
    expect(feedbackAct!.actor).toBe('human');
    expect(feedbackAct!.body).toBe('please fix the null check');
    expect(feedbackAct!.createdAt).toBe(FIXED_TS);

    const statusAct = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'queued');
    expect(statusAct).toBeDefined();
    expect(statusAct!.actor).toBe('human');
    expect(statusAct!.fromStatus).toBe('in_review');
    expect(statusAct!.toStatus).toBe('queued');
    expect(statusAct!.createdAt).toBe(FIXED_TS);
  });

  // ── Guard test: blocked → queued must be rejected (critical) ─────────────

  it('GUARD: blocked task → InvalidTransitionError (explicit in_review guard; blocked→queued is otherwise human-valid)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='blocked' WHERE key=?").run(task.key);

    const activityBefore = recentActivity(db, task.id, 100).length;

    expect(() =>
      reviewRequestChanges(db, task.key, { feedback: 'fix it' }, fixedNow)
    ).toThrow(InvalidTransitionError);

    const row = findRowByKey(db, task.key)!;
    expect(row.status).toBe('blocked');
    expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
  });

  // ── Rejects other non-in_review statuses ─────────────────────────────────

  it.each<Status>(['backlog', 'queued', 'in_progress', 'done'])(
    'rejects from status=%s with InvalidTransitionError; nothing changed',
    (status) => {
      const db = makeTestDb();
      const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
      db.prepare('UPDATE task SET status=? WHERE key=?').run(status, task.key);

      const activityBefore = recentActivity(db, task.id, 100).length;

      expect(() =>
        reviewRequestChanges(db, task.key, { feedback: 'fix it' }, fixedNow)
      ).toThrow(InvalidTransitionError);

      const row = findRowByKey(db, task.key)!;
      expect(row.status).toBe(status);
      expect(recentActivity(db, task.id, 100).length).toBe(activityBefore);
    },
  );

  // ── Feedback visible to next claim (end-to-end) ───────────────────────────

  it('feedback visible to next claim: claimNextTask returns TaskDetail.activity containing the feedback entry', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    reviewRequestChanges(db, task.key, { feedback: 'please fix the null check' }, fixedNow);
    // task is now queued; claimNextTask should pick it up

    const claimed = claimNextTask(db);

    expect(claimed).not.toBeNull();
    expect(claimed!.key).toBe(task.key);

    const feedbackEntry = claimed!.activity.find(a => a.type === 'feedback');
    expect(feedbackEntry).toBeDefined();
    expect(feedbackEntry!.body).toBe('please fix the null check');
  });

  // ── Validation ────────────────────────────────────────────────────────────

  it('empty feedback → ValidationError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    expect(() =>
      reviewRequestChanges(db, task.key, { feedback: '' }, fixedNow)
    ).toThrow(ValidationError);
  });

  it('whitespace-only feedback → ValidationError', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    expect(() =>
      reviewRequestChanges(db, task.key, { feedback: '   ' }, fixedNow)
    ).toThrow(ValidationError);
  });

  // ── Unknown key ───────────────────────────────────────────────────────────

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();

    expect(() =>
      reviewRequestChanges(db, 'AF-9999', { feedback: 'fix it' }, fixedNow)
    ).toThrow(NotFoundError);
  });
});
