import { describe, it, expect } from 'vitest';
import { createCore, InvalidTransitionError, reviewApprove, type Status } from '../src/index.js';
import { makeTestDb } from './helpers.js';

const prUrl = 'https://github.com/acme/widgets/pull/42';
const merged = { prUrl, prId: '#42', prState: 'merged' as const, checksState: 'failing' as const,
  failing: [{ name: 'verify', url: 'https://ci/42' }] };

function fixture(status: Status = 'blocked') {
  const db = makeTestDb();
  const core = createCore(db, { resolveOrigin: () => 'https://github.com/acme/widgets.git' });
  const key = core.createTask({ title: 'Merge recovery', spec: 's', acceptanceCriteria: 'a' }).key;
  core.updateStatus(key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker' });
  core.submitResult(key, { summary: 'original fix', links: [{ kind: 'pr', label: '#42', url: prUrl }] });
  core.reviewApprove(key);
  if (status !== 'delivering') {
    core.failDelivery(key, { reason: 'ci_failed', detail: 'verify failed' });
    if (status !== 'queued') core.claimNextTask({ claimedBy: 'repair' });
    if (status === 'blocked') core.updateStatus(key, 'blocked', 'agent', 'Docker denied');
    if (status === 'in_review') core.submitResult(key, { summary: 'repair' });
  }
  // Model an old server which stored the observation without reconciling status.
  const legacyMerge = () => db.prepare("UPDATE task_delivery SET pr_state='merged', checks_state='failing', pr_id='#42', checked_at='2026-09-14T12:00:00Z' WHERE task_id=(SELECT id FROM task WHERE key=?)").run(key);
  return { core, db, key, legacyMerge };
}

describe('merged delivery recovery', () => {
  it('reconciles a legacy merge before reserving another dispatcher attempt', () => {
    const { core, key, legacyMerge } = fixture('queued');
    legacyMerge();
    expect(core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 })).toBeNull();
    expect(core.getTask(key).status).toBe('done');
  });

  it('retains a late repair summary when submission discovers a legacy merge', () => {
    const { core, key, legacyMerge } = fixture('in_progress');
    legacyMerge();
    const task = core.submitResult(key, { summary: 'late repair result', claimAt: core.getTask(key).claimedAt! });
    expect(task).toMatchObject({ status: 'done', resultSummary: 'original fix' });
    expect(task.activity.at(-1)?.body).toContain('late repair result');
  });

  it.each(['delivering', 'queued', 'in_progress', 'blocked', 'in_review'] as const)(
    'finishes %s atomically, retaining checks and ending its session once', (status) => {
      const { core, key } = fixture(status);
      const before = core.getTask(key);
      expect(core.recordDeliveryCheck(key, merged).changed).toBe(true);
      const done = core.getTask(key);
      expect(done.status).toBe('done');
      expect(done.delivery).toMatchObject(merged);
      expect(done.resultSummary).toBe(before.resultSummary);
      expect(done.activity.slice(0, before.activity.length)).toEqual(before.activity);
      expect(done.activity.at(-1)).toMatchObject({ fromStatus: status, toStatus: 'done' });
      expect(done.activity.at(-1)!.body).toContain('checks failing');
      expect(core.listLiveAgents()).toEqual([]);
      expect(core.recordDeliveryCheck(key, merged)).toMatchObject({ skipped: true });
      expect(core.getTask(key).activity).toEqual(done.activity);
      expect(() => core.submitResult(key, { summary: 'late repair' })).toThrow(InvalidTransitionError);
      expect(() => core.updateStatus(key, 'blocked', 'agent')).toThrow(InvalidTransitionError);
      expect(() => core.releaseClaim(key)).toThrow(InvalidTransitionError);
    },
  );

  it.each(['passing', 'none', 'pending', 'unknown'] as const)('merge completes with checks %s', (checksState) => {
    const { core, key } = fixture();
    core.recordDeliveryCheck(key, { ...merged, checksState, failing: [] });
    expect(core.getTask(key)).toMatchObject({ status: 'done', delivery: { checksState } });
  });

  it.each(['queued', 'in_progress'] as const)('retry toward %s reconciles a previously recorded merge', (target) => {
    const { core, key, legacyMerge } = fixture();
    legacyMerge();
    expect(core.updateStatus(key, target, target === 'queued' ? 'human' : 'agent').status).toBe('done');
    expect(core.claimNextTask({ taskKey: key, claimedBy: 'unneeded' })).toBeNull();
  });

  it('a queued legacy merged delivery is completed without claiming it or blocking the next task', () => {
    const { core, key, legacyMerge } = fixture('queued');
    legacyMerge();
    const next = core.createTask({ title: 'Next', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(next.key, 'queued', 'human');
    expect(core.claimNextTask({ claimedBy: 'next-worker' })?.key).toBe(next.key);
    expect(core.getTask(key).status).toBe('done');
    expect(core.getTask(key).activity.filter(a => a.toStatus === 'in_progress')).toHaveLength(1);
  });

  it('a resumed legacy repair claim reconciles instead of returning more work', () => {
    const { core, key, legacyMerge } = fixture('in_progress');
    legacyMerge();
    expect(core.claimNextTask({ claimedBy: 'repair', taskKey: key })).toBeNull();
    expect(core.getTask(key).status).toBe('done');
  });

  it('a human can explicitly reopen completed work without an old observation completing it again', () => {
    const { core, key } = fixture();
    const before = core.getTask(key);
    const expected = { status: before.status, branch: before.delivery!.branch,
      prUrl, stateChangedAt: before.delivery!.stateChangedAt };
    core.recordDeliveryCheck(key, merged);
    core.updateStatus(key, 'queued', 'human');
    expect(core.getTask(key).delivery).toBeNull();
    expect(core.recordDeliveryCheck(key, { ...merged, expected })).toMatchObject({ skipped: true });
    expect(core.claimNextTask({ taskKey: key })?.key).toBe(key);
    expect(core.getTask(key).links.some(l => l.url === prUrl)).toBe(true);
  });

  it('an old merged PR cannot complete a newly submitted replacement PR', () => {
    const { core, key } = fixture('in_progress');
    core.submitResult(key, { summary: 'new work', links: [{ kind: 'pr', label: '#43', url: prUrl.replace('42', '43') }] });
    core.recordDeliveryCheck(key, merged);
    expect(core.getTask(key).status).toBe('in_review');
    core.reviewApprove(key);
    expect(core.getTask(key).delivery?.prUrl).toContain('/43');
  });

  it('raw status and completion calls cannot bypass approval or merge evidence', () => {
    const { core, key } = fixture('in_progress');
    expect(() => core.updateStatus(key, 'done', 'agent')).toThrow(InvalidTransitionError);
    expect(() => core.completeDelivery(key, 'pretend it merged')).toThrow(InvalidTransitionError);
    expect(core.getTask(key).status).toBe('in_progress');
  });

  it('a slow approval cannot restore Delivering after the watcher completed its repair', () => {
    const { core, db, key } = fixture('in_review');
    expect(() => reviewApprove(db, key, undefined, null, () => {
      core.recordDeliveryCheck(key, merged);
      return 'https://github.com/acme/widgets.git';
    })).toThrow(InvalidTransitionError);
    expect(core.getTask(key)).toMatchObject({ status: 'done', delivery: { prState: 'merged' } });
  });

  it('archived work cannot be changed by a late merge observation', () => {
    const { core, key } = fixture('delivering');
    core.updateStatus(key, 'done', 'human');
    core.archiveTask(key);
    expect(core.recordDeliveryCheck(key, merged)).toMatchObject({ skipped: true });
    expect(() => core.completeDelivery(key, 'late merge')).toThrow(InvalidTransitionError);
    expect(core.getTask(key).delivery?.prState).toBe('unknown');
  });
});
