import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { releaseClaim } from '../src/ops/releaseClaim.js';
import { reportProgress } from '../src/ops/agentSession.js';
import { submitResult } from '../src/ops/submitResult.js';
import { InvalidTransitionError } from '../src/errors.js';

function queued(db: ReturnType<typeof makeTestDb>) {
  const task = createTask(db, { title: 'Execution ownership', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, task.key, 'queued', 'human');
  return task;
}

describe('execution ownership', () => {
  it('returns the same execution when a claim response is retried', () => {
    const db = makeTestDb();
    const task = queued(db);

    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    const retry = claimNextTask(db, { claimedBy: 'worker-1' });

    expect(first?.key).toBe(task.key);
    expect(first?.executionId).toBeTruthy();
    expect(retry?.executionId).toBe(first?.executionId);
  });

  it('rejects progress and submit from a released execution after a replacement claim', () => {
    const db = makeTestDb();
    const task = queued(db);
    const first = claimNextTask(db, { claimedBy: 'worker-1' });
    expect(first?.executionId).toBeTruthy();

    releaseClaim(db, task.key, undefined, first!.executionId);
    const replacement = claimNextTask(db, { claimedBy: 'worker-2' });
    expect(replacement?.executionId).not.toBe(first?.executionId);

    expect(() => reportProgress(db, task.key, { message: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
    expect(() => submitResult(db, task.key, { summary: 'late', executionId: first!.executionId })).toThrow(InvalidTransitionError);
  });
});
