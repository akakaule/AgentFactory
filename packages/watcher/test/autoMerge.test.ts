import { describe, it, expect } from 'vitest';
import { isFailureMarker } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { deliverTask, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

/**
 * The human already approved the implementation on the board, so a GitHub PR whose checks passed
 * on exactly the approved head is merged by the watcher — nobody has to click Merge on GitHub.
 * (Full SHAs: core only records those.)
 */

const ABC = 'abc'.padEnd(40, '0');
const DEF = 'def'.padEnd(40, '0');
const GH_REPO = 'https://api.github.com/repos/acme/widgets';

interface Call { method: string; url: string; body: unknown }

function deliverAt(core: ReturnType<typeof makeCore>, headSha: string): string {
  const t = core.createTask({ title: 'Ship', spec: 'spec', acceptanceCriteria: 'ac' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  const sub = core.submitResult(t.key, { summary: 'done', revision: { headSha, source: 'origin' } }).submission!;
  expect(core.reviewApprove(t.key, null, null, { submissionId: sub.id, headSha }).status).toBe('delivering');
  return t.key;
}

/** GitHub with one PR (#42) at `head`; its single check run has `run`; PUT /merge answers `merge`. */
function github(opts: {
  head: string;
  run?: { status: string; conclusion: string | null };
  merge?: Partial<FetchResponse>;
}): FetchJson & { calls: Call[] } {
  const calls: Call[] = [];
  let merged = false;
  const fn = (async (url, init) => {
    const method = init.method ?? 'GET';
    calls.push({ method, url, body: init.body ? JSON.parse(init.body) as unknown : undefined });
    const pr = () => ghPr({ head: { sha: opts.head }, ...(merged ? { state: 'closed', merged: true, merged_at: '2026-10-28T00:00:00Z' } : {}) });
    const ok = (body: unknown): FetchResponse => ({ status: 200, headers: {}, body });
    if (method === 'PUT' && url === `${GH_REPO}/pulls/42/merge`) {
      const res = { status: 200, headers: {}, body: { merged: true, sha: 'merge'.padEnd(40, '0') }, ...opts.merge };
      if (res.status === 200) merged = true;
      return res;
    }
    if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return ok([pr()]);
    if (method === 'GET' && url === `${GH_REPO}/pulls/42`) return ok(pr());
    if (method === 'GET' && url.includes('/check-runs')) {
      const run = opts.run ?? { status: 'completed', conclusion: 'success' };
      return ok({ check_runs: [{ name: 'build', html_url: null, details_url: null, ...run }] });
    }
    if (method === 'GET' && url.endsWith('/status')) return ok({ statuses: [] });
    if (method === 'PATCH' && url === `${GH_REPO}/pulls/42`) return ok(pr());
    throw new Error(`unrouted ${method} ${url}`);
  }) as FetchJson & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const merges = (f: { calls: Call[] }) => f.calls.filter((c) => c.method === 'PUT');

describe('watcher merges an approved GitHub PR once its checks pass', () => {
  it('checks passing on the approved head → merges at that head, and the next poll completes the task', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    const fetchJson = github({ head: ABC });
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));

    await w.tick();
    expect(merges(fetchJson)).toEqual([{ method: 'PUT', url: `${GH_REPO}/pulls/42/merge`, body: { sha: ABC, merge_method: 'merge' } }]);

    await w.tick();
    expect(core.getTask(key).status).toBe('done');
    expect(merges(fetchJson)).toHaveLength(1);
  });

  it('uses the configured merge method', async () => {
    const core = makeCore();
    deliverAt(core, ABC);
    const fetchJson = github({ head: ABC });
    await new Watcher(makeConfig({ mergeMethod: 'squash' }), makeDeps(core, fetchJson)).tick();
    expect(merges(fetchJson)[0]!.body).toEqual({ sha: ABC, merge_method: 'squash' });
  });

  it('checks still pending → waits', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    const fetchJson = github({ head: ABC, run: { status: 'in_progress', conclusion: null } });
    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();
    expect(merges(fetchJson)).toHaveLength(0);
    expect(core.getTask(key).status).toBe('delivering');
  });

  it('a PR head other than the approved one is never merged', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    const fetchJson = github({ head: DEF });
    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();
    expect(merges(fetchJson)).toHaveLength(0);
    expect(core.getTask(key).status).toBe('delivering');
  });

  it('an approval with no recorded head is left for a human to merge', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const warnings: string[] = [];
    const fetchJson = github({ head: ABC });
    await new Watcher(makeConfig(), makeDeps(core, fetchJson, { console: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } })).tick();
    expect(merges(fetchJson)).toHaveLength(0);
    expect(core.getTask(key).status).toBe('delivering');
    expect(warnings.join('\n')).toMatch(/approved head is unknown/);
  });

  it('mergePullRequests: false leaves the merge to a human', async () => {
    const core = makeCore();
    deliverAt(core, ABC);
    const fetchJson = github({ head: ABC });
    await new Watcher(makeConfig({ mergePullRequests: false }), makeDeps(core, fetchJson)).tick();
    expect(merges(fetchJson)).toHaveLength(0);
  });

  it('GitHub refusing the merge (branch protection) keeps the task delivering, warns once and keeps polling', async () => {
    const core = makeCore();
    const key = deliverAt(core, ABC);
    const warnings: string[] = [];
    const fetchJson = github({ head: ABC, merge: { status: 405, body: { message: 'At least 1 approving review is required by reviewers with write access.' } } });
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson, { console: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } }));
    await w.tick();
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body))).toHaveLength(0);
    expect(merges(fetchJson)).toHaveLength(2); // no backoff: a human may lift the block any time
    expect(warnings.filter((m) => m.includes('approving review is required'))).toHaveLength(1);
  });

  it('a token without write access backs the task off with the scope hint', async () => {
    const core = makeCore();
    deliverAt(core, ABC);
    const warnings: string[] = [];
    const fetchJson = github({ head: ABC, merge: { status: 403, headers: { 'x-ratelimit-remaining': '4000' }, body: { message: 'Resource not accessible by personal access token' } } });
    await new Watcher(makeConfig(), makeDeps(core, fetchJson, { console: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } })).tick();
    expect(warnings.join('\n')).toMatch(/Contents: write.*GITHUB_TOKEN/s);
  });
});
