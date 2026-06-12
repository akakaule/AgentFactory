import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { reviewRequestChanges } from '../src/ops/reviewRequestChanges.js';
import { addComment } from '../src/ops/addComment.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { analyticsRows } from '../src/ops/analyticsRows.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

/** queue → claim → submit, leaving the task in_review. */
function driveToReview(db: ReturnType<typeof makeTestDb>, title = 'T') {
  const task = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(10));
  claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
  submitResult(db, task.key, { summary: 'done' }, at(90));
  return task;
}

describe('derived aiReview field', () => {
  it('is null when no ai-review comment exists', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    expect(getTask(db, task.key).aiReview).toBeNull();
    expect(listTasks(db).find((t) => t.key === task.key)!.aiReview).toBeNull();
  });

  it('reflects the latest ai-review comment on detail and summary', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: 2 findings\n{"findings":[1,2]}' }, at(95));

    expect(getTask(db, task.key).aiReview).toEqual({ findings: 2 });
    expect(listTasks(db, { status: 'in_review' })[0]!.aiReview).toEqual({ findings: 2 });
  });

  it('uses the latest of several ai-review comments', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: 3 findings\n{"findings":[1,2,3]}' }, at(95));
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: clean' }, at(100));

    expect(getTask(db, task.key).aiReview).toEqual({ findings: 0 });
  });

  it('ignores ordinary comments that lack the marker', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'human', body: 'this looks fine, ai-review pending' }, at(95));
    expect(getTask(db, task.key).aiReview).toBeNull();
  });
});

describe('analyticsRows aiReviewFindings', () => {
  const findFindings = (db: ReturnType<typeof makeTestDb>, key: string) =>
    analyticsRows(db, at(999)).tasks.find((t) => t.key === key)!.aiReviewFindings;

  it('is null for a done task with no AI review (excluded from override rate)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBeNull();
  });

  it('is 0 for a clean approval', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: clean' }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(0);
  });

  it('is > 0 when approved past open findings (an override)', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: 2 findings\n{"findings":[1,2]}' }, at(95));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(2);
  });

  it('snapshots the verdict at the final approval after a request-changes round', () => {
    const db = makeTestDb();
    const task = driveToReview(db);
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: 2 findings\n{"findings":[1,2]}' }, at(95));
    reviewRequestChanges(db, task.key, { feedback: 'address the AI findings' }, at(100));
    claimNextTask(db, { claimedBy: 'worker-1' }, at(110));
    submitResult(db, task.key, { summary: 'fixed' }, at(120));
    addComment(db, task.key, { actor: 'agent', body: 'ai-review: clean' }, at(125));
    reviewApprove(db, task.key, at(150));
    expect(findFindings(db, task.key)).toBe(0);
  });
});
