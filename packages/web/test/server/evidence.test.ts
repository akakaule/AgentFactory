import { describe, it, expect } from 'vitest';
import { openDb, runMigrations, createCore, verificationEvidence } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const HEAD = 'abc1234';
const TS = '2026-10-30T10:00:00.000Z';

/** Fixture 1: current submission #2 (head abc1234), a run bound to it, a verify comment, a passing build check. */
function threeSourceFixture() {
  const db = openDb(':memory:');
  runMigrations(db);
  const core = createCore(db);
  const task = core.createTask({ title: 'Evidence', spec: 'S', acceptanceCriteria: 'A', stage: 'implementation' });
  core.updateStatus(task.key, 'queued', 'human');
  const claim = core.claimNextTask({ claimedBy: 'worker-1' })!;
  const sub = db.prepare(`INSERT INTO task_submission(task_id, stage, execution_id, branch, head_sha, revision_source, observed_at, created_at)
    VALUES (?, 'implementation', ?, 'feature/x', ?, 'origin', ?, ?)`);
  sub.run(task.id, claim.executionId, 'abb1234', TS, TS);
  sub.run(task.id, claim.executionId, HEAD, TS, TS);
  db.prepare(`INSERT INTO task_verification(task_id, execution_id, command, status, exit_code, log, truncated, started_at, finished_at, submission_id, valid_for_revision)
    VALUES (?, ?, 'npm test', 'passed', 0, 'ok', 0, ?, ?, 2, 1)`).run(task.id, claim.executionId, TS, TS);
  core.addComment(task.key, { actor: 'agent', body: 'verify: all green', executionId: claim.executionId });
  db.prepare(`INSERT INTO task_delivery(task_id, provider, branch, pr_state, checks_state, detail, checked_at, state_changed_at, created_at, updated_at, submission_id, approved_head_sha, head_sha)
    VALUES (?, 'github', 'feature/x', 'open', 'passing', ?, ?, ?, ?, ?, 2, ?, ?)`)
    .run(task.id, JSON.stringify({ checks: [{ name: 'build', state: 'passing', url: null }] }), TS, TS, TS, TS, HEAD, HEAD);
  return { core, key: task.key, executionId: claim.executionId };
}

describe('task detail evidence', () => {
  it('getTask and GET /api/tasks/:key both serve verificationEvidence for the fixture', async () => {
    const { core, key, executionId } = threeSourceFixture();
    const detail = core.getTask(key);
    const expected = verificationEvidence({
      submission: detail.submission ?? null,
      verifications: [{
        id: 1, taskKey: key, executionId, command: 'npm test',
        status: 'passed', exitCode: 0, headBefore: null, headAfter: null, cleanBefore: null, cleanAfter: null, log: 'ok', truncated: false,
        startedAt: TS, finishedAt: TS, submissionId: 2, validForRevision: true,
      }],
      activity: detail.activity, delivery: detail.delivery,
    });
    expect(expected).toMatchObject([
      { source: 'runner', state: 'passed', headSha: HEAD },
      { source: 'reported', state: 'unverified', headSha: null },
      { source: 'provider', state: 'passed', label: 'build' },
    ]);
    expect(detail.evidence).toEqual(expected);
    const res = await buildApp(core).request(`/api/tasks/${key}`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { evidence: unknown }).evidence).toEqual(expected);
  });
});
