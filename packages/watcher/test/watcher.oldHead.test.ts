import { describe, it, expect } from 'vitest';
import { isFailureMarker } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { DeliveryProviderApi } from '../src/providers/types.js';
import { fakeFetch, makeConfig, makeCore, makeDeps } from './helpers.js';

// AF-184: a failing check verdict observed on a head other than the approved one must not bounce
// the delivery — the failure belongs to another commit. (Full SHAs: core only accepts those.)
const ABC = 'abc'.padEnd(40, '0');
const DEF = 'def'.padEnd(40, '0');

function deliverAt(core: ReturnType<typeof makeCore>, headSha: string): string {
  const t = core.createTask({ title: 'Ship', spec: 'spec', acceptanceCriteria: 'ac' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  const sub = core.submitResult(t.key, { summary: 'done', revision: { headSha, source: 'origin' } }).submission!;
  expect(core.reviewApprove(t.key, null, null, { submissionId: sub.id, headSha }).status).toBe('delivering');
  return t.key;
}

/** A watcher whose provider reports an open PR at `headSha` with a failing `build` check. */
class StubbedWatcher extends Watcher {
  constructor(core: ReturnType<typeof makeCore>, private readonly headSha: string | null) {
    super(makeConfig(), makeDeps(core, fakeFetch([])));
  }
  protected override buildProvider(): DeliveryProviderApi {
    return {
      key: 'github',
      check: async () => ({
        pr: { id: '#42', url: 'https://github.com/acme/widgets/pull/42', state: 'open', headSha: this.headSha, mergeCommitSha: null },
        checks: { state: 'failing', failing: [{ name: 'build', url: 'https://gh/run/1' }] },
      }),
      openPullRequest: async () => null,
    };
  }
}

const failureNotes = (core: ReturnType<typeof makeCore>, key: string) =>
  core.getTask(key).activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body));

describe('watcher bounces only for check failures on the approved head', () => {
  it('a failure reported for another head leaves the task delivering without a failure note', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    await new StubbedWatcher(core, DEF).tick();
    expect(core.getTask(key).status).toBe('delivering');
    expect(failureNotes(core, key)).toHaveLength(0);
  });

  it('a failure reported for the approved head bounces once', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    await new StubbedWatcher(core, ABC).tick();
    expect(core.getTask(key).status).toBe('queued');
    expect(failureNotes(core, key)).toHaveLength(1);
  });

  it('a failure with no reported head bounces once', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    await new StubbedWatcher(core, null).tick();
    expect(core.getTask(key).status).toBe('queued');
    expect(failureNotes(core, key)).toHaveLength(1);
  });
});
