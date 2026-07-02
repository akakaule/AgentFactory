import { describe, it, expect } from 'vitest';
import { openCore, type Core } from '../src/index.js';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { reviewApprove } from '../src/ops/reviewApprove.js';
import { isFailureMarker, parseFailureComment } from '../src/failure.js';
import { InvalidTransitionError, ValidationError } from '../src/errors.js';

const GH = 'https://github.com/acme/widgets.git';

function makeCore(origin: string | null = GH): Core {
  return openCore(':memory:', { resolveOrigin: () => origin });
}

/** create → queue → claim → submit → approve ⇒ delivering (GitHub origin injected). */
function deliverTask(core: Core): string {
  const t = core.createTask({ title: 'Ship it', spec: 's', acceptanceCriteria: 'a' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'w1' });
  core.submitResult(t.key, { summary: 'done' });
  expect(core.reviewApprove(t.key).status).toBe('delivering');
  return t.key;
}

describe('approve → delivering routing', () => {
  it('implementation + branch + recognizable origin routes to delivering and seeds the row', () => {
    const core = makeCore();
    const key = deliverTask(core);
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.delivery).toMatchObject({ provider: 'github', prState: 'unknown', checksState: 'unknown' });
    expect(t.delivery!.branch).toBe(t.branch);
    const act = t.activity.filter((a) => a.type === 'status_change').at(-1)!;
    expect(act).toMatchObject({ actor: 'human', fromStatus: 'in_review', toStatus: 'delivering' });
    expect(act.body).toContain('awaiting PR merge');
  });

  it('the seed picks up the newest pr link from submit_result', () => {
    const core = makeCore();
    const t = core.createTask({ title: 'Ship it', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w1' });
    core.submitResult(t.key, { summary: 'done', links: [{ kind: 'pr', label: '#7', url: 'https://github.com/acme/widgets/pull/7' }] });
    core.reviewApprove(t.key);
    expect(core.getDelivery(t.key)!.prUrl).toBe('https://github.com/acme/widgets/pull/7');
  });

  it('an unrecognizable origin approves straight to done (pre-#18 behavior)', () => {
    const core = makeCore('https://gitlab.com/acme/widgets.git');
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w1' });
    core.submitResult(t.key, { summary: 'done' });
    expect(core.reviewApprove(t.key).status).toBe('done');
    expect(core.getDelivery(t.key)).toBeNull();
  });

  it('no origin at all approves straight to done', () => {
    const core = makeCore(null);
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w1' });
    core.submitResult(t.key, { summary: 'done' });
    expect(core.reviewApprove(t.key).status).toBe('done');
  });

  it('a legacy no-branch task (pre-#6 claim) approves straight to done', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'L', spec: 's', acceptanceCriteria: 'a' });
    db.prepare("UPDATE task SET status='in_review', branch=NULL WHERE key=?").run(t.key);
    const detail = reviewApprove(db, t.key, undefined, null, () => GH);
    expect(detail.status).toBe('done');
    expect(detail.delivery).toBeNull();
  });

  it('doc stages still advance the stage and re-queue (never delivering)', () => {
    const core = makeCore();
    const t = core.createTask({ title: 'T', spec: 's', stage: 'description' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w1' });
    core.submitResult(t.key, { summary: 'wrote it', spec: 'new spec', acceptanceCriteria: 'new ac' });
    const after = core.reviewApprove(t.key);
    expect(after.status).toBe('queued');
    expect(after.stage).toBe('plan');
    expect(core.getDelivery(t.key)).toBeNull();
  });

  it('re-approval after a bounce resets the delivery row', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.recordDeliveryCheck(key, { prState: 'open', checksState: 'failing', failing: [{ name: 'build', url: null }] });
    core.failDelivery(key, { reason: 'ci_failed', detail: 'build failed' });
    // fix round: reclaim, resubmit, re-approve
    core.claimNextTask({ claimedBy: 'w2' });
    core.submitResult(key, { summary: 'fixed' });
    expect(core.reviewApprove(key).status).toBe('delivering');
    expect(core.getDelivery(key)).toMatchObject({ prState: 'unknown', checksState: 'unknown', failing: [] });
  });
});

describe('delivery ops', () => {
  it('recordDeliveryCheck bumps the version only when the observed state changes', () => {
    const core = makeCore();
    const key = deliverTask(core);
    const v0 = core.getVersion();
    const first = core.recordDeliveryCheck(key, { prUrl: 'https://x/pull/1', prId: '#1', prState: 'open', checksState: 'pending' });
    expect(first.changed).toBe(true);
    const v1 = core.getVersion();
    expect(v1).not.toBe(v0);
    const second = core.recordDeliveryCheck(key, { prUrl: 'https://x/pull/1', prId: '#1', prState: 'open', checksState: 'pending' });
    expect(second.changed).toBe(false);
    expect(core.getVersion()).toBe(v1);
    expect(core.getDelivery(key)!.checkedAt).not.toBeNull();
  });

  it('recordDeliveryCheck is a no-op once the task left delivering (human wins the race)', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.updateStatus(key, 'done', 'human'); // force-complete
    const r = core.recordDeliveryCheck(key, { prState: 'merged', checksState: 'passing' });
    expect(r.changed).toBe(false);
    expect(core.getDelivery(key)!.prState).toBe('unknown');
  });

  it('completeDelivery closes with an agent status_change carrying the note; a second call throws', () => {
    const core = makeCore();
    const key = deliverTask(core);
    const done = core.completeDelivery(key, 'PR #1 merged; checks green');
    expect(done.status).toBe('done');
    const act = done.activity.filter((a) => a.type === 'status_change').at(-1)!;
    expect(act).toMatchObject({ actor: 'agent', toStatus: 'done', body: 'PR #1 merged; checks green' });
    expect(() => core.completeDelivery(key, 'again')).toThrow(InvalidTransitionError);
  });

  it('failDelivery re-queues, clears the claimant, and posts exactly one parseable failure/v1', () => {
    const core = makeCore();
    const key = deliverTask(core);
    const t = core.failDelivery(key, { reason: 'ci_failed', detail: 'PR #1 checks failed: build', body: 'Failing checks:\n- build' });
    expect(t.status).toBe('queued');
    expect(t.claimedBy).toBeNull();
    const failures = t.activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body));
    expect(failures).toHaveLength(1);
    expect(parseFailureComment(failures[0]!.body)).toMatchObject({
      reason: 'ci_failed', source: 'watcher', attempt: null, maxAttempts: null,
    });
    expect(t.failure).toMatchObject({ reason: 'ci_failed', skipListed: false });
    expect(() => core.failDelivery(key, { reason: 'pr_closed', detail: 'x' })).toThrow(InvalidTransitionError);
  });

  it('a successful re-submission supersedes the delivery failure chip', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
    core.claimNextTask({ claimedBy: 'w2' });
    core.submitResult(key, { summary: 'fixed' });
    expect(core.getTask(key).failure).toBeNull();
  });

  it('beginDelivery requires delivering status', () => {
    const core = makeCore();
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    expect(() => core.beginDelivery(t.key, { provider: 'github', branch: 'feature/x' })).toThrow(ValidationError);
  });
});
