import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { analyticsRows } from '../src/ops/analyticsRows.js';
import { addComment } from '../src/ops/addComment.js';
import { addTaskMetrics } from '../src/ops/addTaskMetrics.js';
import { buildFailureComment } from '../src/failure.js';
import { featureBranch } from '../src/branch.js';
import { getTask } from '../src/ops/getTask.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

/** Drive one task through queue→claim→submit→approve with fixed timestamps. */
function driveDone(db: ReturnType<typeof makeTestDb>, claimedBy?: string) {
  const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(10));
  claimNextTask(db, claimedBy ? { claimedBy } : {}, at(30));
  submitResult(db, task.key, { summary: 'done' }, at(90));
  reviewApprove(db, task.key, at(150));
  return task;
}

describe('analyticsRows', () => {
  it('produces a derived row per task with worker attribution', () => {
    const db = makeTestDb();
    const task = driveDone(db, 'worker-1');

    const { tasks } = analyticsRows(db, at(999));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      key: task.key, workspace: 'default', status: 'done',
      queueMin: 20, workMin: 60, reviewMin: 60, blockedMin: 0,
      rounds: 0, reopened: false, worker: 'worker-1',
      model: null, tokensIn: null, tokensOut: null, costUsd: null,
    });
    expect(tasks[0]!.doneAt).toBe(at(150)());
  });

  it('exposes the persisted feature branch on the row', () => {
    const db = makeTestDb();
    const task = driveDone(db, 'worker-1'); // implementation-stage claim names the branch
    expect(analyticsRows(db, at(999)).tasks[0]!.branch).toBe(featureBranch(task.key, 'T'));
  });

  it('breaks token usage down by the stage it was reported in', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    updateStatus(db, task.key, 'queued', 'human', at(10));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(30)); // implementation-stage session starts here
    addTaskMetrics(db, task.key, { tokensIn: 8000, tokensOut: 2000 }, at(60));
    submitResult(db, task.key, { summary: 'done' }, at(90));
    reviewApprove(db, task.key, at(150));
    expect(analyticsRows(db, at(999)).tasks[0]!.stageTokens).toEqual({ implementation: 10000 });
  });

  it('leaves worker null for unlabeled claims', () => {
    const db = makeTestDb();
    driveDone(db);
    expect(analyticsRows(db, at(999)).tasks[0]!.worker).toBeNull();
  });

  it('records the worker label in the claim activity row', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    updateStatus(db, task.key, 'queued', 'human', at(10));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(30));

    const claim = getTask(db, task.key).activity.find(
      (a) => a.type === 'status_change' && a.toStatus === 'in_progress',
    );
    expect(claim?.body).toBe('worker-1');
  });

  it('reports a release as a stranded event attributed to the claimant', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    updateStatus(db, task.key, 'queued', 'human', at(10));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
    updateStatus(db, task.key, 'queued', 'human', at(60)); // human release

    const { stranded } = analyticsRows(db, at(999));
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ worker: 'worker-1', workspace: 'default', at: at(60)() });
  });

  it('does not count request-changes as a stranded release', () => {
    const db = makeTestDb();
    const task = driveDone(db, 'worker-1');
    // request-changes path on a second task
    const t2 = createTask(db, { title: 'T2', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    updateStatus(db, t2.key, 'queued', 'human', at(10));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
    submitResult(db, t2.key, { summary: 'v1' }, at(50));
    // in_review → queued is request-changes, not a release
    updateStatus(db, t2.key, 'queued', 'human', at(70));

    expect(analyticsRows(db, at(999)).stranded).toHaveLength(0);
    expect(task.key).toBeDefined();
  });

  it('records each failure/v1 note as a failure event by reason (a task can fail more than once)', () => {
    const db = makeTestDb();
    const task = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' }, at(0));
    updateStatus(db, task.key, 'queued', 'human', at(10));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
    const note = (reason: string, attempt: number) =>
      addComment(db, task.key, { actor: 'agent', body: buildFailureComment({ reason, detail: 'd', source: 'dispatcher', attempt, maxAttempts: 2 }) }, at(40 + attempt));
    note('timeout', 1);
    note('max_attempts', 2);
    addComment(db, task.key, { actor: 'human', body: 'just a plain comment' }, at(45)); // ignored

    const { failures } = analyticsRows(db, at(999));
    expect(failures).toHaveLength(2);
    expect(failures.map((f) => f.reason)).toEqual(['timeout', 'max_attempts']);
    expect(failures[0]).toMatchObject({ reason: 'timeout', workspace: 'default' });
  });

  it('exposes derived metrics on the task detail payload', () => {
    const db = makeTestDb();
    const task = driveDone(db, 'worker-1');

    const detail = getTask(db, task.key);
    expect(detail.metrics).toMatchObject({
      queueMin: 20, workMin: 60, reviewMin: 60, blockedMin: 0,
      rounds: 0, reopened: false, claimCount: 1,
      model: null, tokensIn: null, tokensOut: null, costUsd: null,
    });
  });
});
