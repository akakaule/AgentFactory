import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { releaseClaim } from '../src/ops/releaseClaim.js';
import { recordVerification, latestVerification } from '../src/ops/verification.js';
import { InvalidTransitionError, ValidationError } from '../src/errors.js';

type DB = ReturnType<typeof makeTestDb>;

function claimed(db: DB) {
  const task = createTask(db, { title: 'Verify', spec: 'S', acceptanceCriteria: 'A' });
  updateStatus(db, task.key, 'queued', 'human');
  const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
  return { key: task.key, executionId: claim.executionId };
}

const input = (executionId: string) => ({
  executionId, status: 'failed' as const, exitCode: 1, command: 'npm test',
  headBefore: 'abc', headAfter: 'abc', cleanBefore: true, cleanAfter: true, log: 'x', truncated: false,
});
const rows = (db: DB) => (db.prepare('SELECT COUNT(*) AS n FROM task_verification').get() as { n: number }).n;

describe('runner verification records', () => {
  it('round-trips a record for the live execution', () => {
    const db = makeTestDb();
    const { key, executionId } = claimed(db);
    const now = () => '2026-10-29T12:00:00.000Z';

    const recorded = recordVerification(db, key, input(executionId), now);
    const read = latestVerification(db, key, executionId);

    expect(read).toEqual(recorded);
    expect(read).toMatchObject({
      taskKey: key, executionId, command: 'npm test', status: 'failed', exitCode: 1,
      headBefore: 'abc', headAfter: 'abc', cleanBefore: true, cleanAfter: true, log: 'x', truncated: false,
      startedAt: '2026-10-29T12:00:00.000Z', finishedAt: '2026-10-29T12:00:00.000Z',
      submissionId: null, validForRevision: null,
    });
  });

  it('reads back the latest record of the named execution, and null when it has none', () => {
    const db = makeTestDb();
    const { key, executionId } = claimed(db);
    expect(latestVerification(db, key, executionId)).toBeNull();
    recordVerification(db, key, input(executionId));
    recordVerification(db, key, { ...input(executionId), status: 'passed', exitCode: 0, startedAt: '2026-10-29T12:00:00.000Z', finishedAt: '2026-10-29T12:01:00.000Z' });
    expect(latestVerification(db, key, executionId)).toMatchObject({ status: 'passed', exitCode: 0, finishedAt: '2026-10-29T12:01:00.000Z' });
    expect(latestVerification(db, key, 'other-execution')).toBeNull();
  });

  it('refuses an unknown status and stores nothing', () => {
    const db = makeTestDb();
    const { key, executionId } = claimed(db);
    expect(() => recordVerification(db, key, { ...input(executionId), status: 'ok' } as never)).toThrow(ValidationError);
    expect(rows(db)).toBe(0);
  });

  it('refuses a record from a superseded execution and stores nothing', () => {
    const db = makeTestDb();
    const { key, executionId: e0 } = claimed(db);
    releaseClaim(db, key, undefined, e0);
    const e1 = claimNextTask(db, { claimedBy: 'worker-2' })!.executionId;
    expect(e1).not.toBe(e0);

    expect(() => recordVerification(db, key, input(e0))).toThrow(InvalidTransitionError);
    expect(rows(db)).toBe(0);
    expect(() => recordVerification(db, key, input(e1))).not.toThrow();
  });

  it('requires an execution identity', () => {
    const db = makeTestDb();
    const { key } = claimed(db);
    const { executionId: _, ...unfenced } = input('x');
    expect(() => recordVerification(db, key, unfenced as never)).toThrow(ValidationError);
    expect(rows(db)).toBe(0);
  });
});
