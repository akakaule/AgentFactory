import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { parseCurationComment } from '../src/curation.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';
import type { CurationEntry, Status } from '../src/types.js';

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

  // ── Curation ledger ───────────────────────────────────────────────────────

  const forwarded: CurationEntry = { severity: 'warning', file: 'src/x.ts', line: 1, title: 'Keep', disposition: 'forwarded' };
  const dismissed: CurationEntry = { severity: 'info', file: null, line: null, title: 'Drop', disposition: 'dismissed' };

  it('persists a curation/v1 ledger comment recording the forwarded/dismissed split', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewRequestChanges(db, task.key, {
      feedback: '[reviewer-codex] Keep',
      curation: { reviewer: 'codex', dispositions: [forwarded, dismissed] },
    }, fixedNow);

    const ledger = detail.activity.find((a) => a.type === 'comment' && parseCurationComment(a.body));
    expect(ledger).toBeDefined();
    expect(ledger!.actor).toBe('human');
    const parsed = parseCurationComment(ledger!.body)!;
    expect(parsed.reviewer).toBe('codex');
    expect(parsed.dispositions).toEqual([forwarded, dismissed]);
    // the feedback + status_change are still there
    expect(detail.activity.some((a) => a.type === 'feedback')).toBe(true);
    expect(detail.status).toBe('queued');
  });

  it('emits no curation comment when there is no AI review to curate', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewRequestChanges(db, task.key, { feedback: 'just fix it' }, fixedNow);
    expect(detail.activity.some((a) => a.type === 'comment' && parseCurationComment(a.body))).toBe(false);

    // an empty dispositions array is likewise a no-op
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);
    const d2 = reviewRequestChanges(db, task.key, { feedback: 'again', curation: { reviewer: 'codex', dispositions: [] } }, fixedNow);
    expect(d2.activity.some((a) => a.type === 'comment' && parseCurationComment(a.body))).toBe(false);
  });

  // ── Unknown key ───────────────────────────────────────────────────────────

  it('unknown key → NotFoundError', () => {
    const db = makeTestDb();

    expect(() =>
      reviewRequestChanges(db, 'AF-9999', { feedback: 'fix it' }, fixedNow)
    ).toThrow(NotFoundError);
  });
});
