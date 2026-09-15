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

  it('records delivery facts while a queued repair is waiting for reconciliation', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
    const result = core.recordDeliveryCheck(key, { prState: 'merged', checksState: 'pending' });
    expect(result.changed).toBe(true);
    expect(core.getDelivery(key)).toMatchObject({ prState: 'merged', checksState: 'pending' });
  });

  it('does not claim a queued task whose current delivery is already merged', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.recordDeliveryCheck(key, { prState: 'merged', checksState: 'failing', failing: [{ name: 'build', url: null }] });
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
    expect(core.claimNextTask({ claimedBy: 'retry-worker' })).toBeNull();
    expect(core.reserveRetry(key, { operation: 'dispatcher:implementation', maxAttempts: 2 })).toBeNull();
  });

  it('rejects an observation fenced to an older approval episode', () => {
    const core = makeCore();
    const key = deliverTask(core);
    const oldEpisode = core.getDelivery(key)!.stateChangedAt;
    core.updateStatus(key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'new-worker' });
    core.submitResult(key, { summary: 'replacement' });
    core.reviewApprove(key);
    expect(core.getDelivery(key)!.stateChangedAt).not.toBe(oldEpisode);
    const recorded = core.recordDeliveryCheck(key, {
      expectedStateChangedAt: oldEpisode,
      prState: 'merged',
      checksState: 'passing',
    });
    expect(recorded).toMatchObject({ changed: false, accepted: false, stateChangedAt: null });
    expect(core.getTask(key).status).toBe('delivering');
    expect(core.getDelivery(key)).toMatchObject({ prState: 'unknown', checksState: 'unknown' });
  });

  it('rejects a late submission from an old claim after completion and re-claim', () => {
    const core = makeCore();
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    const oldClaim = core.claimNextTask({ claimedBy: 'old-worker' }, () => '2030-08-01T10:00:00.000Z')!;
    core.submitResult(t.key, { summary: 'original', claimAt: oldClaim.claimedAt! });
    core.reviewApprove(t.key);
    core.recordDeliveryCheck(t.key, { prState: 'merged', checksState: 'passing' });
    core.completeDelivery(t.key, 'PR merged; checks green');

    core.updateStatus(t.key, 'queued', 'human');
    const newClaim = core.claimNextTask({ claimedBy: 'new-worker' }, () => '2030-08-01T11:00:00.000Z')!;

    expect(() => core.submitResult(t.key, { summary: 'stale repair', claimAt: oldClaim.claimedAt! })).toThrow(/stale claim/);
    expect(core.getTask(t.key)).toMatchObject({ status: 'in_progress', claimedBy: 'new-worker', claimedAt: newClaim.claimedAt, resultSummary: 'original' });
  });

  it('allows merged delivery completion from a queued repair', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
    const done = core.completeDelivery(key, 'PR #42 merged; checks pending', core.getDelivery(key)!.stateChangedAt);
    expect(done.status).toBe('done');
  });

  it('an active repair submit reconciles a merged delivery and preserves the original result', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
    core.claimNextTask({ claimedBy: 'repair-worker' });
    core.recordDeliveryCheck(key, {
      prState: 'merged', checksState: 'failing', prId: '#42',
      prUrl: 'https://github.com/acme/widgets/pull/42',
      failing: [{ name: 'post-merge build', url: null }],
    });

    const submitted = core.submitResult(key, { summary: 'late repair result' });

    expect(submitted.status).toBe('done');
    expect(submitted.resultSummary).toBe('done');
    expect(submitted.delivery).toMatchObject({ prState: 'merged', checksState: 'failing', prId: '#42' });
    expect(submitted.failure).toMatchObject({ source: 'watcher', reason: 'ci_failed' });
    expect(submitted.activity.some((a) => a.type === 'comment' && a.body.includes('late repair result'))).toBe(true);
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
      reason: 'ci_failed', source: 'watcher', attempt: 1, maxAttempts: 2,
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

  it('stops repeated CI repair bounces after two delivery repairs, including after re-approval', () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red 1' });
    core.claimNextTask({ claimedBy: 'w2' });
    core.submitResult(key, { summary: 'fixed 1' });
    core.reviewApprove(key);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red 2' });

    const blocked = core.getTask(key);
    expect(blocked.status).toBe('queued');
    expect(blocked.failure).toMatchObject({ source: 'watcher', attempt: 2, maxAttempts: 2, skipListed: true });
    expect(core.claimNextTask({ claimedBy: 'interactive-worker' })).toBeNull();

    core.restartTask(key);
    expect(core.claimNextTask({ claimedBy: 'interactive-worker' })?.key).toBe(key);
  });

  it('beginDelivery requires delivering status', () => {
    const core = makeCore();
    const t = core.createTask({ title: 'T', spec: 's', acceptanceCriteria: 'a' });
    expect(() => core.beginDelivery(t.key, { provider: 'github', branch: 'feature/x' })).toThrow(ValidationError);
  });
});
