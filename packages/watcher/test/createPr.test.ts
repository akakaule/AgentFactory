import { describe, it, expect } from 'vitest';
import type { Core } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { ADO_ORIGIN, deliverTask, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';
import { expectedRevisionOf } from '@agentfactory/core';

/**
 * Default flow (2026-10-21): the worker pushes before review but never opens the PR. Once the
 * implementation review is approved the task is `delivering`, and the watcher opens the PR
 * against the repository's default branch — GitHub and Azure DevOps alike.
 */

interface Call { method: string; url: string; body: unknown }
type Handler = (method: string, url: string, body: unknown) => Partial<FetchResponse> | undefined;

/** A fetch fake that records method/url/JSON body and routes through `handler` (undefined = unrouted). */
function apiFake(handler: Handler): FetchJson & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    const res = handler(method, url, body);
    if (!res) throw new Error(`apiFake: unrouted ${method} ${url}`);
    return { status: 200, headers: {}, body: null, ...res };
  }) as FetchJson & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const GH_REPO = 'https://api.github.com/repos/acme/widgets';
const ADO_BASE = 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets';
const noChecks = { check_runs: [] };

/** GitHub API: `search` is what the head-branch search returns; POST /pulls answers `create`. */
function github(search: unknown[], create: Partial<FetchResponse> = { status: 201, body: ghPr({ number: 43, html_url: 'https://github.com/acme/widgets/pull/43' }) }) {
  return apiFake((method, url) => {
    if (method === 'GET' && url === GH_REPO) return { body: { default_branch: 'main' } };
    if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return { body: search };
    if (method === 'POST' && url === `${GH_REPO}/pulls`) return create;
    if (method === 'GET' && url.includes('/check-runs')) return { body: noChecks };
    if (method === 'GET' && url.endsWith('/status')) return { body: { statuses: [] } };
    return undefined;
  });
}

const posts = (f: { calls: Call[] }) => f.calls.filter((c) => c.method === 'POST');

describe('watcher opens the PR after approval', () => {
  it('GitHub: no PR for the branch → opens one into the default branch and records it', async () => {
    const core = makeCore();
    const key = deliverTask(core, 'Ship the widget');
    const branch = core.getTask(key).branch!;
    const fetchJson = github([]);

    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();

    expect(posts(fetchJson)).toHaveLength(1);
    expect(posts(fetchJson)[0]!.body).toMatchObject({ head: branch, base: 'main', title: `${key}: Ship the widget` });
    expect((posts(fetchJson)[0]!.body as { body: string }).body).toContain('done'); // the worker's result summary
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.delivery).toMatchObject({ prState: 'open', prUrl: 'https://github.com/acme/widgets/pull/43', prId: '#43', checksState: 'pending' });
  });

  it('GitHub: the next tick follows the recorded PR and does not open another', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    let created = false;
    const fetchJson = apiFake((method, url) => {
      if (method === 'GET' && url === GH_REPO) return { body: { default_branch: 'main' } };
      if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return { body: created ? [ghPr({ number: 43 })] : [] };
      if (method === 'POST' && url === `${GH_REPO}/pulls`) { created = true; return { status: 201, body: ghPr({ number: 43, html_url: 'https://github.com/acme/widgets/pull/43' }) }; }
      if (method === 'GET' && url === `${GH_REPO}/pulls/43`) return { body: ghPr({ number: 43, html_url: 'https://github.com/acme/widgets/pull/43' }) };
      if (url.includes('/check-runs')) return { body: noChecks };
      if (url.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    await w.tick();
    expect(posts(fetchJson)).toHaveLength(1);
    expect(core.getTask(key).delivery).toMatchObject({ prState: 'open', prId: '#43' });
  });

  it('GitHub: a create POST that times out after creating the PR is found by head branch, never POSTed twice', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    let created = false;
    let clock = 1_000_000;
    const fetchJson = apiFake((method, url) => {
      if (method === 'GET' && url === GH_REPO) return { body: { default_branch: 'main' } };
      if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return { body: created ? [ghPr({ number: 43, html_url: 'https://github.com/acme/widgets/pull/43' })] : [] };
      if (method === 'POST' && url === `${GH_REPO}/pulls`) { created = true; throw new Error('request timed out'); }
      if (url.includes('/check-runs')) return { body: noChecks };
      if (url.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson, { now: () => clock }));
    await w.tick();
    expect(core.getTask(key).delivery).toMatchObject({ prState: 'not_found' });
    clock += 3_600_000; // past the create-failure backoff
    await w.tick();
    await w.tick();
    expect(posts(fetchJson)).toHaveLength(1);
    expect(core.getTask(key)).toMatchObject({ status: 'delivering', delivery: { prState: 'open', prId: '#43', prUrl: 'https://github.com/acme/widgets/pull/43' } });
  });

  it('GitHub 422 "already exists" → records not_found without a bounce or backoff', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = github([], { status: 422, body: { message: 'Validation Failed', errors: [{ message: 'A pull request already exists for acme:feature/x.' }] } });
    const warnings: string[] = [];
    await new Watcher(makeConfig(), makeDeps(core, fetchJson, { console: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } })).tick();
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.delivery).toMatchObject({ prState: 'not_found' });
    expect(warnings).toEqual([]);
  });

  it('a create failure (missing write scope) records not_found, warns about the write scope, and backs off', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = github([], { status: 403, headers: { 'x-ratelimit-remaining': '4999' }, body: { message: 'Resource not accessible by personal access token' } });
    const warnings: string[] = [];
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson, { console: { log: () => {}, warn: (m: string) => warnings.push(m), error: () => {} } }));
    await w.tick();
    expect(core.getTask(key)).toMatchObject({ status: 'delivering', delivery: { prState: 'not_found' } });
    expect(warnings.join('\n')).toMatch(/pull requests: write/i);
    const before = fetchJson.calls.length;
    await w.tick(); // inside the backoff window → no re-poll
    expect(fetchJson.calls.length).toBe(before);
  });

  it('a closed PR from an earlier episode is ignored: a fresh PR is opened, no pr_closed bounce', async () => {
    const core = makeCore();
    const key = deliverTask(core); // the episode has no attributed PR (workers no longer submit one)
    const fetchJson = github([ghPr({ number: 41, state: 'closed', merged_at: null, html_url: 'https://github.com/acme/widgets/pull/41' })]);

    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();

    expect(posts(fetchJson)).toHaveLength(1);
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.failure ?? null).toBeNull();
    expect(t.delivery).toMatchObject({ prState: 'open', prId: '#43' });
  });

  it('prefers the open PR over a more recently updated closed one (no create, no bounce)', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = github([
      ghPr({ number: 41, state: 'closed', merged_at: null }), // most recently updated first (sort=updated)
      ghPr({ number: 42, state: 'open' }),
    ]);
    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();
    expect(posts(fetchJson)).toHaveLength(0);
    expect(core.getTask(key)).toMatchObject({ status: 'delivering', delivery: { prState: 'open', prId: '#42' } });
  });

  it('never opens a PR outside delivering (a repair in flight owns the branch)', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    core.failDelivery(key, { reason: 'ci_failed', detail: 'red' }); // → queued, delivery row kept
    const fetchJson = github([]);
    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();
    expect(posts(fetchJson)).toHaveLength(0);
    expect(core.getTask(key).status).toBe('queued');
  });

  it('createPullRequests: false leaves the PR to a human (not_found, no POST)', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = github([]);
    await new Watcher(makeConfig({ createPullRequests: false }), makeDeps(core, fetchJson)).tick();
    expect(posts(fetchJson)).toHaveLength(0);
    expect(core.getTask(key).delivery).toMatchObject({ prState: 'not_found' });
  });

  describe('Azure DevOps', () => {
    const adoPr = (id: number, status = 'active') => ({
      pullRequestId: id, status, mergeStatus: 'succeeded',
      lastMergeSourceCommit: { commitId: 'src' }, lastMergeCommit: { commitId: 'merge' },
    });
    function ado(search: unknown[], create: Partial<FetchResponse> = { status: 201, body: adoPr(77) }) {
      return apiFake((method, url) => {
        if (method === 'GET' && url.startsWith(`${ADO_BASE}?`)) return { body: { defaultBranch: 'refs/heads/main' } };
        if (method === 'GET' && url.startsWith(`${ADO_BASE}/pullrequests?searchCriteria`)) return { body: { value: search } };
        if (method === 'POST' && url.startsWith(`${ADO_BASE}/pullrequests?`)) return create;
        if (method === 'GET' && url.includes('/statuses')) return { body: { value: [] } };
        if (method === 'GET' && url.includes('/_apis/policy/evaluations?')) return { body: { value: [] } };
        if (method === 'GET' && url.includes('/_apis/projects/')) return { body: { id: 'proj-guid' } };
        return undefined;
      });
    }
    const adoDeps = (core: Core, fetchJson: FetchJson, now: () => number = () => Date.now()) =>
      makeDeps(core, fetchJson, { resolveOrigin: () => ADO_ORIGIN, now });

    it('no PR for the branch → opens one into the default branch and records it', async () => {
      const core = makeCore(ADO_ORIGIN);
      const key = deliverTask(core, 'Ship it');
      const branch = core.getTask(key).branch!;
      const fetchJson = ado([]);

      await new Watcher(makeConfig(), adoDeps(core, fetchJson)).tick();

      expect(posts(fetchJson)).toHaveLength(1);
      expect(posts(fetchJson)[0]!.body).toMatchObject({
        sourceRefName: `refs/heads/${branch}`, targetRefName: 'refs/heads/main', title: `${key}: Ship it`,
      });
      expect(core.getTask(key).delivery).toMatchObject({
        prState: 'open', prId: '!77', prUrl: 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/77',
      });
    });

    it('a create POST that times out after creating the PR is found by head branch, never POSTed twice', async () => {
      const core = makeCore(ADO_ORIGIN);
      const key = deliverTask(core);
      let created = false;
      let clock = 1_000_000;
      const fetchJson = apiFake((method, url) => {
        if (method === 'GET' && url.startsWith(`${ADO_BASE}?`)) return { body: { defaultBranch: 'refs/heads/main' } };
        if (method === 'GET' && url.startsWith(`${ADO_BASE}/pullrequests?searchCriteria`)) return { body: { value: created ? [adoPr(77)] : [] } };
        if (method === 'GET' && created && url.startsWith(`${ADO_BASE}/pullrequests/77?`)) return { body: adoPr(77) };
        if (method === 'POST' && url.startsWith(`${ADO_BASE}/pullrequests?`)) { created = true; throw new Error('request timed out'); }
        if (method === 'GET' && url.includes('/statuses')) return { body: { value: [] } };
        if (method === 'GET' && url.includes('/_apis/policy/evaluations?')) return { body: { value: [] } };
        if (method === 'GET' && url.includes('/_apis/projects/')) return { body: { id: 'proj-guid' } };
        return undefined;
      });
      const w = new Watcher(makeConfig(), adoDeps(core, fetchJson, () => clock));
      await w.tick();
      expect(core.getTask(key).delivery).toMatchObject({ prState: 'not_found' });
      clock += 3_600_000; // past the create-failure backoff
      await w.tick();
      await w.tick();
      expect(posts(fetchJson)).toHaveLength(1);
      expect(core.getTask(key)).toMatchObject({
        status: 'delivering',
        delivery: { prState: 'open', prId: '!77', prUrl: 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/77' },
      });
    });

    it('409 (an active PR already exists) → records not_found without a bounce', async () => {
      const core = makeCore(ADO_ORIGIN);
      const key = deliverTask(core);
      const fetchJson = ado([], { status: 409, body: { message: 'TF401179: An active pull request for the source and target branch already exists.' } });
      await new Watcher(makeConfig(), adoDeps(core, fetchJson)).tick();
      expect(core.getTask(key)).toMatchObject({ status: 'delivering', delivery: { prState: 'not_found' } });
    });

    it('an abandoned PR from an earlier episode is ignored: a fresh PR is opened', async () => {
      const core = makeCore(ADO_ORIGIN);
      const key = deliverTask(core);
      const fetchJson = ado([adoPr(76, 'abandoned')]);
      await new Watcher(makeConfig(), adoDeps(core, fetchJson)).tick();
      expect(posts(fetchJson)).toHaveLength(1);
      expect(core.getTask(key)).toMatchObject({ status: 'delivering', delivery: { prState: 'open', prId: '!77' } });
    });

    it('truncates a long PR description to the 4000-character limit', async () => {
      const core = makeCore(ADO_ORIGIN);
      const t = core.createTask({ title: 'Long', spec: 's', acceptanceCriteria: 'a' });
      core.updateStatus(t.key, 'queued', 'human');
      core.claimNextTask({ claimedBy: 'w' });
      core.submitResult(t.key, { summary: 'x'.repeat(6000) });
      core.reviewApprove(t.key, undefined, undefined, expectedRevisionOf(core.getTask(t.key)));
      const fetchJson = ado([]);
      await new Watcher(makeConfig(), adoDeps(core, fetchJson)).tick();
      expect((posts(fetchJson)[0]!.body as { description: string }).description.length).toBeLessThanOrEqual(4000);
    });
  });
});
