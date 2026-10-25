import { describe, it, expect } from 'vitest';
import { Watcher } from '../src/watcher.js';
import { fakeFetch, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

// AF-148: the provider's PR head is persisted next to the approved head; a push after approval
// marks the approved submission stale instead of silently inheriting its review.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const running = { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null, html_url: null, details_url: null }] };

function deliverAt(core: ReturnType<typeof makeCore>, headSha: string): string {
  const t = core.createTask({ title: 'Ship', spec: 'spec', acceptanceCriteria: 'ac' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  const sub = core.submitResult(t.key, { summary: 'done', revision: { headSha, source: 'origin' } }).submission!;
  expect(core.reviewApprove(t.key, null, null, { submissionId: sub.id, headSha }).status).toBe('delivering');
  return t.key;
}

async function poll(core: ReturnType<typeof makeCore>, prHead: string) {
  const fetchJson = fakeFetch([
    ['/pulls?head=', { body: [ghPr({ head: { sha: prHead } })] }],
    ['/check-runs', { body: running }],
    ['/status', { body: { statuses: [] } }],
  ]);
  await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();
}

describe('watcher persists the provider-observed PR head', () => {
  it('a PR head equal to the approved one keeps the submission current', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    await poll(core, A);
    expect(core.getTask(key)).toMatchObject({ delivery: { approvedHeadSha: A, headSha: A }, submission: { freshness: 'current' } });
  });

  it('a push after approval is recorded and marks the approved submission stale', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    await poll(core, B);
    expect(core.getTask(key)).toMatchObject({
      delivery: { approvedHeadSha: A, headSha: B },
      submission: { freshness: 'stale', lastObservation: { headSha: B, source: 'provider' } },
    });
  });

  it('a provider head that is not a full SHA is not recorded', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    await poll(core, 'headsha');
    expect(core.getTask(key).delivery).toMatchObject({ headSha: null });
  });
});

describe('watcher persists provider failures as unknown freshness', () => {
  it('a failed provider poll after observing A marks the submission unknown with the error', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    await poll(core, A);
    const failing = fakeFetch([['/pulls', { status: 503, body: { message: 'unavailable' } }]]);
    await new Watcher(makeConfig(), makeDeps(core, failing)).tick();
    const d = core.getTask(key);
    expect(d.submission).toMatchObject({ freshness: 'unknown', lastObservation: { headSha: A, source: 'provider' } });
    expect(d.submission?.lastObservation?.error).toMatch(/503/);
  });

  it('a failed provider poll after a push keeps the submission stale', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    await poll(core, B);
    const failing = fakeFetch([['/pulls', { status: 503, body: { message: 'unavailable' } }]]);
    await new Watcher(makeConfig(), makeDeps(core, failing)).tick();
    expect(core.getTask(key).submission).toMatchObject({ freshness: 'stale', lastObservation: { headSha: B } });
  });
});

describe('watcher fences a failed poll to the delivery it was started for', () => {
  it('a failure that returns after a newer submission was approved and observed leaves it current', async () => {
    const core = makeCore();
    const key = deliverAt(core, A);
    // while the poll for submission A is in flight: A bounces, B is approved and observed current
    const failing = (async () => {
      core.failDelivery(key, { reason: 'ci_failed', detail: 'red' });
      core.claimNextTask({ claimedBy: 'worker-1' });
      const sub = core.submitResult(key, { summary: 'fix', revision: { headSha: B, source: 'origin' } }).submission!;
      core.reviewApprove(key, null, null, { submissionId: sub.id, headSha: B });
      core.recordDeliveryCheck(key, { prUrl: null, prId: null, prState: 'not_found', checksState: 'unknown', failing: [], headSha: B });
      return { status: 503, headers: {}, body: { message: 'unavailable' } };
    }) as unknown as Parameters<typeof makeDeps>[1];
    await new Watcher(makeConfig(), makeDeps(core, failing)).tick();
    expect(core.getTask(key).submission).toMatchObject({ headSha: B, freshness: 'current' });
  });
});
