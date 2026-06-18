import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { addComment } from '../src/ops/addComment.js';
import { getTask } from '../src/ops/getTask.js';
import { listTasks } from '../src/ops/listTasks.js';
import { buildFailureComment } from '../src/failure.js';

const BASE = Date.parse('2026-06-01T00:00:00.000Z');
const at = (min: number) => () => new Date(BASE + min * 60000).toISOString();

const failBody = (over: Partial<{ reason: string; attempt: number; maxAttempts: number }> = {}) =>
  buildFailureComment({ reason: 'crashed', detail: 'exited with code 1', source: 'dispatcher', attempt: 1, maxAttempts: 2, ...over });

/** queue → claim, leaving the task in_progress under worker-1. */
function driveToInProgress(db: ReturnType<typeof makeTestDb>, title = 'T') {
  const task = createTask(db, { title, spec: 'S', acceptanceCriteria: 'A' }, at(0));
  updateStatus(db, task.key, 'queued', 'human', at(10));
  claimNextTask(db, { claimedBy: 'worker-1' }, at(30));
  return task;
}

describe('derived failure field', () => {
  it('is null when no failure comment exists', () => {
    const db = makeTestDb();
    const task = driveToInProgress(db);
    expect(getTask(db, task.key).failure).toBeNull();
    expect(listTasks(db).find((t) => t.key === task.key)!.failure).toBeNull();
  });

  it('surfaces the latest failure/v1 note (the dispatcher release path)', () => {
    const db = makeTestDb();
    const task = driveToInProgress(db);
    // dispatcher releases a crashed claim: posts the failure note, then re-queues
    addComment(db, task.key, { actor: 'agent', body: failBody({ reason: 'timeout', attempt: 1, maxAttempts: 2 }) }, at(95));
    updateStatus(db, task.key, 'queued', 'human', at(96));

    const f = getTask(db, task.key).failure!;
    expect(f.reason).toBe('timeout');
    expect(f.source).toBe('dispatcher');
    expect(f.attempt).toBe(1);
    expect(f.skipListed).toBe(false);
    expect(listTasks(db, { status: 'queued' })[0]!.failure).toMatchObject({ reason: 'timeout' });
  });

  it('flags skipListed on the max_attempts note', () => {
    const db = makeTestDb();
    const task = driveToInProgress(db);
    addComment(db, task.key, { actor: 'agent', body: failBody({ reason: 'crashed', attempt: 2, maxAttempts: 2 }) }, at(95));
    addComment(db, task.key, { actor: 'agent', body: failBody({ reason: 'max_attempts', attempt: 2, maxAttempts: 2 }) }, at(96));
    updateStatus(db, task.key, 'queued', 'human', at(97));
    expect(getTask(db, task.key).failure).toMatchObject({ reason: 'max_attempts', skipListed: true });
  });

  it('clears once a later result supersedes it (a retry succeeded)', () => {
    const db = makeTestDb();
    const task = driveToInProgress(db);
    addComment(db, task.key, { actor: 'agent', body: failBody({ reason: 'crashed', attempt: 1, maxAttempts: 2 }) }, at(95));
    updateStatus(db, task.key, 'queued', 'human', at(96));
    // a fresh claim succeeds → result postdates the failure note → failure cleared
    claimNextTask(db, { claimedBy: 'worker-2' }, at(100));
    submitResult(db, task.key, { summary: 'fixed on retry' }, at(120));
    expect(getTask(db, task.key).failure).toBeNull();
  });

  it('ignores ordinary comments and malformed markers', () => {
    const db = makeTestDb();
    const task = driveToInProgress(db);
    addComment(db, task.key, { actor: 'human', body: 'looks like it failed/v1 maybe' }, at(95));
    addComment(db, task.key, { actor: 'agent', body: 'failure/v1 broken\n{ not json' }, at(96));
    expect(getTask(db, task.key).failure).toBeNull();
  });
});
