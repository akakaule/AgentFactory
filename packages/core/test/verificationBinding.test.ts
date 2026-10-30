import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { submitResult } from '../src/ops/submitResult.js';
import { recordVerification, latestVerification } from '../src/ops/verification.js';
import { ValidationError } from '../src/errors.js';

type DB = ReturnType<typeof makeTestDb>;
// full SHAs standing in for the criteria's 'abc' (submitted), 'abb' and 'abd'
const ABC = 'abc'.padEnd(40, '0');
const ABB = 'abb'.padEnd(40, '0');
const ABD = 'abd'.padEnd(40, '0');
const BASE = 'f'.repeat(40);

function claimed(db: DB) {
  const task = createTask(db, { title: 'Bind', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
  updateStatus(db, task.key, 'queued', 'human');
  const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
  return { key: task.key, executionId: claim.executionId };
}

const run = (executionId: string) => ({
  executionId, status: 'passed' as const, exitCode: 0, command: 'npm test',
  headBefore: ABC, headAfter: ABC, cleanBefore: true, cleanAfter: true, log: 'ok', truncated: false,
});

function bind(override: Partial<ReturnType<typeof run>>, headSha = ABC) {
  const db = makeTestDb();
  const { key, executionId } = claimed(db);
  recordVerification(db, key, { ...run(executionId), ...override });
  const d = submitResult(db, key, { summary: 'done', executionId, verification: 'green', revision: { headSha, baseSha: BASE, source: 'origin' } });
  return { submissionId: d.submission!.id, v: latestVerification(db, key, executionId)! };
}

describe('binding a runner verification to the submitted revision', () => {
  it('links a passing clean run on the submitted head as valid for that revision', () => {
    const { submissionId, v } = bind({});
    expect(v.submissionId).toBe(submissionId);
    expect(v.validForRevision).toBe(true);
  });

  it('a run that left the worktree dirty does not prove the revision', () => {
    const { submissionId, v } = bind({ cleanAfter: false });
    expect(v).toMatchObject({ submissionId, validForRevision: false });
  });

  it('a run during which the head moved does not prove the revision', () => {
    const { submissionId, v } = bind({ headBefore: ABB });
    expect(v).toMatchObject({ submissionId, validForRevision: false });
  });

  it('a run on another head than the submitted one does not prove the revision', () => {
    const { submissionId, v } = bind({}, ABD);
    expect(v).toMatchObject({ submissionId, validForRevision: false });
  });

  it('a failed run is linked but does not prove the revision', () => {
    const { submissionId, v } = bind({ status: 'failed', exitCode: 1 });
    expect(v).toMatchObject({ submissionId, validForRevision: false });
  });

  describe('the workspace verify-command requirement', () => {
    const requireVerify = (db: DB) => db.prepare("UPDATE workspace SET verify_command='npm test' WHERE id=1").run();

    it('is met by a linked verification valid for the submitted revision', () => {
      const db = makeTestDb();
      requireVerify(db);
      const { key, executionId } = claimed(db);
      recordVerification(db, key, run(executionId));
      const d = submitResult(db, key, { summary: 'done', executionId, revision: { headSha: ABC, baseSha: BASE, source: 'origin' } });
      expect(d.status).toBe('in_review');
      expect(latestVerification(db, key, executionId)).toMatchObject({ submissionId: d.submission!.id, validForRevision: true });
    });

    it('is unmet without a verification record or a verification string', () => {
      const db = makeTestDb();
      requireVerify(db);
      const { key, executionId } = claimed(db);
      const submit = () => submitResult(db, key, { summary: 'done', executionId, revision: { headSha: ABC, baseSha: BASE, source: 'origin' } });
      expect(submit).toThrow(ValidationError);
      expect(submit).toThrow('this workspace requires verification');
    });

    it('is unmet by a linked verification that does not prove the revision', () => {
      const db = makeTestDb();
      requireVerify(db);
      const { key, executionId } = claimed(db);
      recordVerification(db, key, { ...run(executionId), cleanAfter: false });
      expect(() => submitResult(db, key, { summary: 'done', executionId, revision: { headSha: ABC, baseSha: BASE, source: 'origin' } }))
        .toThrow('this workspace requires verification');
    });
  });
});
