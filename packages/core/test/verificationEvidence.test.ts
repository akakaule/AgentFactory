import { describe, expect, it } from 'vitest';
import { makeTestDb } from './helpers.js';
import { verificationEvidence, type EvidenceSource } from '../src/verificationEvidence.js';
import type { DeliverySummary, Verification } from '../src/types.js';
import { createTask } from '../src/ops/createTask.js';
import { updateStatus } from '../src/ops/updateStatus.js';
import { claimNextTask } from '../src/ops/claimNextTask.js';
import { getTask } from '../src/ops/getTask.js';
import { addComment } from '../src/ops/addComment.js';
import { verificationsFor } from '../src/repo/verifications.js';
import { upsertDelivery, deliveryRowFor, updateDeliveryObservation } from '../src/repo/delivery.js';

const HEAD = 'abc1234';

const runner = (over: Partial<Verification>): Verification => ({
  id: 1, taskKey: 'AF-1', executionId: 'e1', command: 'npm test', status: 'passed',
  exitCode: 0, headBefore: null, headAfter: null, cleanBefore: true, cleanAfter: true, log: 'ok', truncated: false,
  startedAt: '2026-10-30T10:00:00.000Z', finishedAt: '2026-10-30T10:01:00.000Z',
  submissionId: 2, validForRevision: true, ...over,
});

const reported = { type: 'comment' as const, actor: 'agent' as const, body: 'verify: all green', createdAt: '2026-10-30T10:02:00.000Z' };

const delivery: DeliverySummary = {
  provider: 'github', branch: 'feature/AF-1-x', prUrl: 'https://github.com/o/r/pull/1', prId: '1',
  prState: 'open', checksState: 'passing', failing: [],
  checks: [{ name: 'build', state: 'passing', url: null }],
  checkedAt: '2026-10-30T10:03:00.000Z', stateChangedAt: '2026-10-30T10:03:00.000Z',
  approvedHeadSha: HEAD, headSha: HEAD, submissionId: 2,
};

const source = (over: Partial<EvidenceSource>): EvidenceSource => ({
  submission: { id: 2, headSha: HEAD }, verifications: [], activity: [], delivery: null, ...over,
});

describe('verificationEvidence', () => {
  it('AC1: lists runner, reported and provider items in that order', () => {
    const items = verificationEvidence(source({ verifications: [runner({})], activity: [reported], delivery }));
    expect(items).toHaveLength(3);
    expect(items).toMatchObject([
      { source: 'runner', state: 'passed', headSha: HEAD },
      { source: 'reported', state: 'unverified', headSha: null },
      { source: 'provider', state: 'passed', label: 'build' },
    ]);
  });

  it('AC2: a verify comment alone is one unverified reported item', () => {
    const items = verificationEvidence(source({ activity: [reported] }));
    expect(items).toEqual([{ source: 'reported', state: 'unverified', headSha: null, at: reported.createdAt, label: 'all green' }]);
  });

  it('ignores comments that are not agent verify attestations', () => {
    const items = verificationEvidence(source({ activity: [
      { ...reported, actor: 'human' }, { ...reported, body: 'looks fine' }, { ...reported, type: 'result' as const },
    ] }));
    expect(items).toEqual([]);
  });

  it('AC3: a passing run bound to an older submission is stale', () => {
    const [item] = verificationEvidence(source({ verifications: [runner({ submissionId: 1 })] }));
    expect(item).toMatchObject({ source: 'runner', state: 'stale' });
  });

  it('AC4: a run that does not prove the current revision is stale unless it failed', () => {
    expect(verificationEvidence(source({ verifications: [runner({ validForRevision: false })] }))[0])
      .toMatchObject({ source: 'runner', state: 'stale' });
    expect(verificationEvidence(source({ verifications: [runner({ status: 'failed', validForRevision: false })] }))[0])
      .toMatchObject({ source: 'runner', state: 'failed' });
  });

  it('an unbound run is stale', () => {
    expect(verificationEvidence(source({ verifications: [runner({ submissionId: null, validForRevision: null })] }))[0])
      .toMatchObject({ state: 'stale' });
  });

  it('provider checks map failing/pending, and read stale once the delivery is for another submission or head', () => {
    const checks = [{ name: 'lint', state: 'failing' as const, url: null }, { name: 'e2e', state: 'pending' as const, url: null }];
    expect(verificationEvidence(source({ delivery: { ...delivery, checks } })).map((i) => [i.label, i.state]))
      .toEqual([['lint', 'failed'], ['e2e', 'unverified']]);
    expect(verificationEvidence(source({ delivery: { ...delivery, submissionId: 1 } }))[0]).toMatchObject({ state: 'stale' });
    expect(verificationEvidence(source({ delivery: { ...delivery, headSha: 'def5678' } }))[0]).toMatchObject({ state: 'stale' });
  });

  it('a delivery recorded without per-check detail falls back to its failing list and aggregate state', () => {
    const { checks: _drop, ...legacy } = delivery;
    expect(verificationEvidence(source({ delivery: legacy })).map((i) => [i.label, i.state])).toEqual([['checks', 'passed']]);
    const failing = { ...legacy, checksState: 'failing' as const, failing: [{ name: 'build', url: null }] };
    expect(verificationEvidence(source({ delivery: failing })).map((i) => [i.label, i.state])).toEqual([['build', 'failed']]);
    expect(verificationEvidence(source({ delivery: { ...legacy, checksState: 'unknown' } }))).toEqual([]);
  });
});

describe('TaskDetail.evidence', () => {
  it('AC5: getTask serves the function output for the three-source fixture', () => {
    const { db, key, taskId } = threeSourceFixture();
    const detail = getTask(db, key);
    expect(detail.evidence).toMatchObject([
      { source: 'runner', state: 'passed', headSha: HEAD, label: 'npm test' },
      { source: 'reported', state: 'unverified', headSha: null, label: 'all green' },
      { source: 'provider', state: 'passed', headSha: HEAD, label: 'build' },
    ]);
    expect(detail.evidence).toEqual(verificationEvidence({
      submission: detail.submission ?? null, verifications: verificationsFor(db, taskId, key),
      activity: detail.activity, delivery: detail.delivery,
    }));
  });
});

/** Fixture 1 in a DB: current submission #2 (head abc1234), a run bound to it, a verify comment, a passing build check. */
function threeSourceFixture(db = makeTestDb()) {
  const task = createTask(db, { title: 'Evidence', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
  updateStatus(db, task.key, 'queued', 'human');
  const claim = claimNextTask(db, { claimedBy: 'worker-1' })!;
  const ts = '2026-10-30T10:00:00.000Z';
  const sub = db.prepare(`INSERT INTO task_submission(task_id, stage, execution_id, branch, head_sha, revision_source, observed_at, created_at)
    VALUES (?, 'implementation', ?, 'feature/x', ?, 'origin', ?, ?)`);
  sub.run(task.id, claim.executionId, 'abb1234', ts, ts);
  sub.run(task.id, claim.executionId, HEAD, ts, ts);
  db.prepare(`INSERT INTO task_verification(task_id, execution_id, command, status, exit_code, log, truncated, started_at, finished_at, submission_id, valid_for_revision)
    VALUES (?, ?, 'npm test', 'passed', 0, 'ok', 0, ?, ?, 2, 1)`).run(task.id, claim.executionId, ts, ts);
  addComment(db, task.key, { actor: 'agent', body: 'verify: all green', executionId: claim.executionId });
  upsertDelivery(db, task.id, { provider: 'github', branch: 'feature/x', prUrl: null, submissionId: 2, approvedHeadSha: HEAD }, ts);
  updateDeliveryObservation(db, deliveryRowFor(db, task.id)!, {
    prState: 'open', checksState: 'passing', headSha: HEAD, checks: [{ name: 'build', state: 'passing', url: null }],
  }, ts);
  return { db, key: task.key, taskId: task.id };
}

