import { describe, it, expect } from 'vitest';
import { Reviewer } from '../src/reviewer.js';
import { makeCore, seedInReview, aiReviewBody, makeConfig, makeDeps, makeFakeSpawn, makeFakeConsole } from './helpers.js';

// AF-148: a posted review names the submission it reviewed and the head it actually diffed, so a
// later push cannot inherit it and a review of a moved branch is never proof for the submission.
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

function implInReview(headSha: string) {
  const core = makeCore();
  const t = core.createTask({ title: 'Bound', spec: 'S', acceptanceCriteria: 'A', workspace: 'ws', stage: 'implementation' });
  core.updateStatus(t.key, 'queued', 'human');
  const claim = core.claimNextTask({ workspace: 'ws', claimedBy: 'worker' })!;
  const sub = core.submitResult(t.key, { summary: 'impl', revision: { headSha, baseSha: BASE, source: 'origin' },
    links: [{ kind: 'branch', label: claim.branch!, url: 'https://example.test/b' }] }).submission!;
  return { core, key: t.key, sub };
}

async function reviewOnce(core: ReturnType<typeof makeCore>, diffHead: string | undefined) {
  const { spawn, calls } = makeFakeSpawn();
  const computeDiff = async () => ({ baseRef: 'main', diff: 'diff --git a/a b/a\n+x', commits: 1, ...(diffHead ? { headSha: diffHead, baseSha: BASE } : {}) });
  const r = new Reviewer(makeConfig({ visualization: { enabled: false } }), makeDeps(core, spawn, { computeDiff, readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));
  await r.tick();
  expect(calls).toHaveLength(1);
  await calls[0]!.child.exit(0);
}

describe('reviewer binds its verdict to the submitted revision', () => {
  it('a review of the submitted head is posted bound and reads current', async () => {
    const { core, key, sub } = implInReview(A);
    await reviewOnce(core, A);
    const review = core.getTask(key).activity.find((a) => a.body.startsWith('ai-review/v1'))!;
    expect(review.body).toContain(`review-revision/v1 submission=#${sub.id} head=${A}`);
    expect(core.getTask(key).aiReview).toMatchObject({ verdict: 'clean', binding: 'current', revision: { submissionId: sub.id, headSha: A } });
  });

  it('a review that diffed a newer push is stale: its clean verdict is not proof for the submission', async () => {
    const { core, key } = implInReview(A);
    await reviewOnce(core, B);
    expect(core.getTask(key).aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
  });

  it('a doc-stage review is bound to the submission by id', async () => {
    const core = makeCore();
    const key = seedInReview(core, 'ws', 'Plan', 'plan');
    const sub = core.getTask(key).submission!;
    await reviewOnce(core, undefined);
    const review = core.getTask(key).activity.find((a) => a.body.startsWith('ai-review/v1'))!;
    expect(review.body).toContain(`review-revision/v1 submission=#${sub.id}`);
  });
});

describe('reviewer does not loop on a revision only a resubmission can fix', () => {
  it('a stale review of the current submission (branch moved) is not re-reviewed every tick', async () => {
    const { core, key } = implInReview(A);
    const { spawn, calls } = makeFakeSpawn();
    const computeDiff = async () => ({ baseRef: 'main', diff: 'diff --git a/a b/a\n+x', commits: 1, headSha: B, baseSha: BASE });
    const r = new Reviewer(makeConfig({ visualization: { enabled: false } }), makeDeps(core, spawn, { computeDiff, readOutput: () => aiReviewBody(0), console: makeFakeConsole() }));
    await r.tick();
    await calls[0]!.child.exit(0);
    expect(core.getTask(key).aiReview).toMatchObject({ verdict: 'pending', binding: 'stale' });
    await r.tick();
    await r.tick();
    expect(calls).toHaveLength(1);
  });

  it('a review superseded by a newer submission is re-reviewed', async () => {
    const { core, key } = implInReview(A);
    await reviewOnce(core, A);
    core.reviewRequestChanges(key, { feedback: 'again' });
    const claim = core.claimNextTask({ workspace: 'ws', claimedBy: 'worker' })!;
    core.submitResult(key, { summary: 'v2', revision: { headSha: B, source: 'origin' }, links: [{ kind: 'branch', label: claim.branch!, url: 'https://example.test/b' }] });
    expect(core.getTask(key).aiReview).toMatchObject({ verdict: 'pending', binding: 'superseded' });
    await reviewOnce(core, B);
    expect(core.getTask(key).aiReview).toMatchObject({ verdict: 'clean', binding: 'current' });
  });
});
