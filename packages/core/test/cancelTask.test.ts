import { describe, it, expect } from 'vitest';
import { createCore, InvalidTransitionError, type Status } from '../src/index.js';
import { openDb } from '../src/db.js';
import { runMigrations, widenCheck } from '../src/migrate.js';
import { isValidTransition } from '../src/transitions.js';
import { createExecution } from '../src/repo/execution.js';
import { makeTestDb } from './helpers.js';
import { expectedRevisionOf } from '../src/ops/approval.js';

const prUrl = 'https://github.com/acme/widgets/pull/42';

function fixture() {
  const db = makeTestDb();
  const core = createCore(db, { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
  const create = (title = 'Cancel me') => core.createTask({ title, spec: 's', acceptanceCriteria: 'a' }).key;
  return { db, core, create };
}

/** Drive a fresh task into `status` through the real lifecycle. */
function taskIn(status: Status) {
  const f = fixture();
  const key = f.create();
  if (status === 'backlog') return { ...f, key };
  f.core.updateStatus(key, 'queued', 'human');
  if (status === 'queued') return { ...f, key };
  const claim = f.core.claimNextTask({ claimedBy: 'worker-1' })!;
  if (status === 'in_progress') return { ...f, key, claim };
  if (status === 'blocked') { f.core.updateStatus(key, 'blocked', 'agent', null, 'stuck', claim.executionId); return { ...f, key, claim }; }
  f.core.submitResult(key, { summary: 'done', links: [{ kind: 'pr', label: '#42', url: prUrl }], executionId: claim.executionId });
  if (status === 'in_review') return { ...f, key, claim };
  f.core.reviewApprove(key, undefined, undefined, expectedRevisionOf(f.core.getTask(key)));
  if (status === 'delivering') return { ...f, key, claim };
  f.core.updateStatus(key, 'done', 'human');
  return { ...f, key, claim };
}

const ALL: Status[] = ['backlog', 'queued', 'in_progress', 'in_review', 'blocked', 'delivering', 'done'];

describe('cancelled transitions', () => {
  it('every status can be cancelled by a human, never by an agent', () => {
    for (const from of ALL) {
      expect(isValidTransition(from, 'cancelled', 'human')).toBe(true);
      expect(isValidTransition(from, 'cancelled', 'agent')).toBe(false);
    }
  });

  it('a cancelled task reopens to the queue (or to review, kind-gated) only by a human', () => {
    expect(isValidTransition('cancelled', 'queued', 'human')).toBe(true);
    expect(isValidTransition('cancelled', 'in_review', 'human')).toBe(true);
    expect(isValidTransition('cancelled', 'queued', 'agent')).toBe(false);
    for (const to of ['in_progress', 'done', 'delivering', 'blocked', 'backlog'] as const)
      expect(isValidTransition('cancelled', to, 'human')).toBe(false);
  });

  it.each(ALL)('cancels a task in %s and records the reason', (status) => {
    const { core, key } = taskIn(status);
    const detail = core.updateStatus(key, 'cancelled', 'human', null, 'not needed any more');
    expect(detail.status).toBe('cancelled');
    expect(detail.activity.find((a) => a.toStatus === 'cancelled')).toMatchObject({ type: 'status_change', fromStatus: status, toStatus: 'cancelled', body: 'not needed any more' });
  });
});

describe('cancelling live work', () => {
  it('settles the worker execution, ends the live session and clears the claim', () => {
    const { db, core, key, claim } = taskIn('in_progress');
    core.reportProgress(key, { message: 'editing', executionId: claim!.executionId });
    expect(core.listLiveAgents().map((a) => a.key)).toContain(key);

    const detail = core.updateStatus(key, 'cancelled', 'human');

    expect(detail).toMatchObject({ claimedBy: null, claimedAt: null });
    expect(core.listLiveAgents().map((a) => a.key)).not.toContain(key);
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(claim!.executionId)).toEqual({ state: 'cancelled' });
  });

  it('fences the cancelled worker: its submit and progress are refused', () => {
    const { core, key, claim } = taskIn('in_progress');
    core.updateStatus(key, 'cancelled', 'human');
    expect(() => core.submitResult(key, { summary: 'late', executionId: claim!.executionId })).toThrow(InvalidTransitionError);
    expect(() => core.reportProgress(key, { message: 'late', executionId: claim!.executionId })).toThrow(InvalidTransitionError);
    expect(core.getTask(key).status).toBe('cancelled');
  });

  it('settles a running review attempt as cancelled, refunding it, and fences the verdict post', () => {
    const { core, key } = taskIn('in_review');
    const review = core.reserveExecution(key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true })!;
    expect(core.getRetryBudget(key, 'reviewer:implementation')).toMatchObject({ attemptsUsed: 1 });

    core.updateStatus(key, 'cancelled', 'human');

    expect(core.getRetryBudget(key, 'reviewer:implementation')).toMatchObject({ attemptsUsed: 0 });
    expect(() => core.addComment(key, { body: 'late verdict', actor: 'agent', executionId: review.id })).toThrow(InvalidTransitionError);
  });

  it('settles every live execution on the task, not only the newest', () => {
    const { db, core, key } = taskIn('in_review');
    const taskId = (db.prepare('SELECT id FROM task WHERE key = ?').get(key) as { id: number }).id;
    // an older execution of another operation still running alongside the newest one
    const older = createExecution(db, { taskId, taskKey: key, stage: 'implementation', operation: 'visualization:old', generation: 1,
      attempt: 1, maxAttempts: 1, owner: 'reviewer-1', now: '2026-01-01T00:00:00.000Z' });
    core.reserveExecution(key, { operation: 'reviewer:implementation', maxAttempts: 2, owner: 'reviewer-1', startImmediately: true });

    core.updateStatus(key, 'cancelled', 'human');

    expect(db.prepare("SELECT COUNT(*) AS c FROM task_execution WHERE task_id = ? AND state IN ('reserved','running')").get(taskId)).toEqual({ c: 0 });
    expect(db.prepare('SELECT state FROM task_execution WHERE id = ?').get(older.id)).toEqual({ state: 'cancelled' });
  });

  it('a merged delivery never resurrects a cancelled task', () => {
    const { db, core, key } = taskIn('delivering');
    core.updateStatus(key, 'cancelled', 'human');
    const check = core.recordDeliveryCheck(key, { prUrl, prId: '#42', prState: 'merged', checksState: 'passing', failing: [] });
    expect(check.skipped).toBe(true);
    db.prepare("UPDATE task_delivery SET pr_state='merged' WHERE task_id=(SELECT id FROM task WHERE key=?)").run(key);
    expect(core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 })).toBeNull();
    expect(core.getTask(key).status).toBe('cancelled');
  });

  it('is never claimed', () => {
    const { core, key } = taskIn('queued');
    core.updateStatus(key, 'cancelled', 'human');
    expect(core.claimNextTask({ claimedBy: 'worker-2' })).toBeNull();
  });
});

describe('reopening a cancelled task', () => {
  it('re-queues with a fresh dispatcher budget and no leftover delivery', () => {
    const { db, core, key } = taskIn('delivering');
    const spent = core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 })!;
    core.settleRetry(spent.id, { state: 'failed' });
    core.updateStatus(key, 'cancelled', 'human');
    const before = core.getRetryBudget(key, 'dispatcher:implementation')!;

    const detail = core.updateStatus(key, 'queued', 'human');

    expect(detail.status).toBe('queued');
    expect(detail.delivery).toBeNull();
    expect(db.prepare('SELECT COUNT(*) AS c FROM task_delivery WHERE task_id = (SELECT id FROM task WHERE key = ?)').get(key)).toEqual({ c: 0 });
    expect(core.getRetryBudget(key, 'dispatcher:implementation')!.generation).toBeGreaterThan(before.generation);
    expect(core.claimNextTask({ claimedBy: 'worker-2' })?.key).toBe(key);
  });

  it('a code task cannot jump from cancelled straight to review', () => {
    const { core, key } = taskIn('queued');
    core.updateStatus(key, 'cancelled', 'human');
    expect(() => core.updateStatus(key, 'in_review', 'human')).toThrow(/only a pr-review task/);
  });

  it('a pr-review task reopens to review and can never be queued', () => {
    const { core } = fixture();
    const key = core.createTask({ title: 'Review PR', spec: 's', acceptanceCriteria: 'a', kind: 'pr-review',
      links: [{ kind: 'branch', label: 'feature/teammate', url: 'https://github.com/o/r/pull/1' }] }).key;
    core.updateStatus(key, 'in_review', 'human');
    core.updateStatus(key, 'cancelled', 'human');
    expect(() => core.updateStatus(key, 'queued', 'human')).toThrow(/cannot be queued/);
    expect(core.updateStatus(key, 'in_review', 'human').status).toBe('in_review');
  });
});

describe('archiving a cancelled task', () => {
  it('archives and unarchives, keeping the cancelled status', () => {
    const { core, key } = taskIn('queued');
    core.updateStatus(key, 'cancelled', 'human');
    expect(core.archiveTask(key)).toMatchObject({ status: 'cancelled' });
    expect(core.listTasks({ archived: true }).map((t) => t.key)).toEqual([key]);
    expect(() => core.updateStatus(key, 'queued', 'human')).toThrow(/archived/);
    expect(core.unarchiveTask(key)).toMatchObject({ status: 'cancelled', archivedAt: null });
  });

  it('bulk archive-done leaves cancelled tasks alone', () => {
    const { core, key } = taskIn('queued');
    core.updateStatus(key, 'cancelled', 'human');
    expect(core.archiveDoneTasks()).toEqual({ archived: 0 });
  });
});

describe('migration #29 cancelled', () => {
  it('widens the task status CHECK to accept cancelled', () => {
    const db = makeTestDb();
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 30 });
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','cancelled',1,1,'2026-01-01','2026-01-01')",
    ).run()).not.toThrow();
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-2','t','s','a','bogus',2,1,'2026-01-01','2026-01-01')",
    ).run()).toThrow();
  });

  it('upgrades a version-28 database keeping task rows and their children', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    db.exec('PRAGMA foreign_keys = OFF');
    widenCheck(db, 'task',
      "('backlog','queued','in_progress','in_review','delivering','done','blocked','cancelled')",
      "('backlog','queued','in_progress','in_review','delivering','done','blocked')");
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA user_version = 28');
    db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,workspace_id,created_at,updated_at) VALUES ('AF-1','t','s','a','in_review',1,1,'2026-01-01','2026-01-01')",
    ).run();
    db.prepare("INSERT INTO activity(task_id,type,actor,body,created_at) VALUES ((SELECT id FROM task WHERE key='AF-1'),'comment','human','kept','2026-01-01')").run();

    runMigrations(db);

    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 30 });
    expect(db.prepare("SELECT body FROM activity WHERE task_id = (SELECT id FROM task WHERE key='AF-1')").get()).toEqual({ body: 'kept' });
    db.prepare("UPDATE task SET status = 'cancelled' WHERE key = 'AF-1'").run();
    expect(db.prepare("SELECT status FROM task WHERE key='AF-1'").get()).toEqual({ status: 'cancelled' });
  });
});
