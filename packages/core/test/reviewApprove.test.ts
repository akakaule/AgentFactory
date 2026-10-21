import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { findRowByKey } from '../src/repo/tasks.js';
import { recentActivity } from '../src/repo/activity.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';
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

  it.each<Status>(['backlog', 'queued', 'in_progress', 'delivering', 'done', 'blocked'])(
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

  // ── Doc-stage approvals advance the stage instead of closing ─────────────

  it('approving an in-review description (spec) stage advances to implementation and re-queues (NOT done)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_review', claimed_by='w1', claimed_at=? WHERE key=?").run(FIXED_TS, task.key);

    const detail = reviewApprove(db, task.key, fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.stage).toBe('implementation');
    expect(detail.claimedBy).toBeNull();

    const act = detail.activity.find(a => a.type === 'status_change' && a.toStatus === 'queued');
    expect(act).toBeDefined();
    expect(act!.actor).toBe('human');
    expect(act!.fromStatus).toBe('in_review');
    expect(act!.body).toContain('description → implementation');
  });

  it('approving a legacy in-review plan stage advances to implementation', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A', stage: 'plan' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);

    const detail = reviewApprove(db, task.key, fixedNow);

    expect(detail.status).toBe('queued');
    expect(detail.stage).toBe('implementation');
  });

  it('approving a doc stage over open findings logs the override comment and still advances', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', stage: 'description' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);
    const body = 'ai-review/v1 — 2 findings (claude)\n```json\n' + JSON.stringify({
      reviewer: 'claude', verdict: 'findings',
      findings: [{ title: 'a', severity: 'warning' }, { title: 'b', severity: 'error' }],
    }) + '\n```';
    db.prepare("INSERT INTO activity(task_id, type, actor, body, created_at) VALUES (?, 'comment', 'human', ?, ?)").run(task.id, body, FIXED_TS);

    const detail = reviewApprove(db, task.key, fixedNow, null, () => null, 'The spec gap is tracked separately.');

    expect(detail.stage).toBe('implementation');
    const override = detail.activity.find(a => a.type === 'comment' && a.body.startsWith('override:'));
    expect(override).toBeDefined();
    expect(override!.body).toBe('override: approved over 1 must-fix and 1 minor issue\n\nReason: The spec gap is tracked separately.');
  });
});

describe('reviewApprove — approving over open issues needs a reason', () => {
  const v1 = (findings: object[]) => 'ai-review/v1 — findings (codex)\n```json\n' + JSON.stringify({ reviewer: 'codex', verdict: 'findings', findings }) + '\n```';
  const v2Disputed = (participants = ['claude/a', 'codex/b']) => 'ai-review/v2\n```json\n' + JSON.stringify({
    reviewer: participants.join(' + '), verdict: 'disputed', findings: [],
    consensus: { participants, status: 'disputed', history: [], candidates: [{
      id: 'F1', source: participants[0], finding: { title: 'Maybe racy', severity: 'warning', file: null, line: null, detail: null }, outcome: 'disputed',
      votes: [{ reviewer: participants[0], decision: 'confirm', severity: 'warning', evidence: 'Saw it', duplicateOf: null },
        { reviewer: participants[1], decision: 'confirm', severity: 'error', evidence: 'Worse than that', duplicateOf: null }],
    }] },
  }) + '\n```';
  function inReview(reviewBody: string | null) {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: '1. Race — one claim wins\n2. Logs — one line' });
    db.prepare("UPDATE task SET status='in_review' WHERE key=?").run(task.key);
    if (reviewBody) db.prepare("INSERT INTO activity(task_id, type, actor, body, created_at) VALUES (?, 'comment', 'agent', ?, ?)").run(task.id, reviewBody, FIXED_TS);
    return { db, task };
  }
  const overrides = (db: ReturnType<typeof makeTestDb>, id: number) =>
    recentActivity(db, id, 50).filter(a => a.type === 'comment' && a.body.startsWith('override:')).map(a => a.body);

  it('a must-fix issue without a reason is rejected and the task stays in review', () => {
    const { db, task } = inReview(v1([{ title: 'AC1 race: two claims win', severity: 'error' }]));
    for (const reason of [undefined, null, '   ']) {
      expect(() => reviewApprove(db, task.key, fixedNow, null, () => null, reason)).toThrow(ValidationError);
      expect(() => reviewApprove(db, task.key, fixedNow, null, () => null, reason)).toThrow(/needs a reason/);
    }
    expect(findRowByKey(db, task.key)!.status).toBe('in_review');
    expect(overrides(db, task.id)).toEqual([]);
  });

  it('with a reason it approves and the override comment records the reason and the open issues', () => {
    const { db, task } = inReview(v1([
      { title: 'AC1 race', severity: 'error' }, { title: 'Slow', severity: 'warning' }, { title: 'Naming', severity: 'info' },
    ]));
    const detail = reviewApprove(db, task.key, fixedNow, null, () => null, '  Hotfix; the race is covered by the lock in AF-12.  ');
    expect(detail.status).toBe('done');
    expect(overrides(db, task.id)).toEqual(['override: approved over 1 must-fix and 2 minor issues\n\nReason: Hotfix; the race is covered by the lock in AF-12.']);
  });

  it('an open decision (a consensus dispute) also needs a reason', () => {
    const { db, task } = inReview(v2Disputed());
    expect(() => reviewApprove(db, task.key, fixedNow)).toThrow(/needs a reason/);
    reviewApprove(db, task.key, fixedNow, null, () => null, 'Agreed with Claude: a warning.');
    expect(overrides(db, task.id)).toEqual(['override: approved over 1 open decision\n\nReason: Agreed with Claude: a warning.']);
  });

  it('minor issues only approve without a reason and still write the override comment', () => {
    const { db, task } = inReview(v1([{ title: 'Slow', severity: 'warning' }, { title: 'Naming', severity: 'info' }]));
    expect(reviewApprove(db, task.key, fixedNow).status).toBe('done');
    expect(overrides(db, task.id)).toEqual(['override: approved over 2 minor issues']);
  });

  it('a pending review (a newer result) approves without a reason and logs no override', () => {
    const { db, task } = inReview(v1([{ title: 'Broken', severity: 'error' }]));
    db.prepare("INSERT INTO activity(task_id, type, actor, body, created_at) VALUES (?, 'result', 'agent', 'fixed', ?)").run(task.id, FIXED_TS);
    expect(reviewApprove(db, task.key, fixedNow).status).toBe('done');
    expect(overrides(db, task.id)).toEqual([]);
  });

  it('a clean review or no review approves in one call as before', () => {
    for (const body of [v1([]), null]) { // zero findings derive the clean verdict
      const { db, task } = inReview(body);
      expect(reviewApprove(db, task.key, fixedNow).status).toBe('done');
      expect(overrides(db, task.id)).toEqual([]);
    }
  });
});
