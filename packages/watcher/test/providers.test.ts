import { describe, it, expect } from 'vitest';
import { makeGitHubProvider, combineChecks } from '../src/providers/github.js';
import { makeAzdoProvider, combineAdoStatuses, parseBuildId } from '../src/providers/azdo.js';
import { ProviderHttpError, type DeliveryCheckResult } from '../src/providers/types.js';
import { parseRemoteUrl } from '@agentfactory/core';
import { fakeFetch, ghPr, GH_ORIGIN, ADO_ORIGIN } from './helpers.js';

const ghRemote = parseRemoteUrl(GH_ORIGIN)!;
const adoRemote = parseRemoteUrl(ADO_ORIGIN)!;

describe('combineChecks (github)', () => {
  const run = (status: string, conclusion: string | null, name = 'build') =>
    ({ name, status, conclusion, html_url: 'https://x/run', details_url: null });

  it('red beats pending beats green', () => {
    expect(combineChecks([run('completed', 'failure'), run('in_progress', null)], []).state).toBe('failing');
    expect(combineChecks([run('completed', 'success'), run('queued', null)], []).state).toBe('pending');
    expect(combineChecks([run('completed', 'success')], []).state).toBe('passing');
  });
  it('no checks at all is "none" (check-less repos flow through)', () => {
    expect(combineChecks([], []).state).toBe('none');
  });
  it('neutral/skipped/stale conclusions are not failures', () => {
    expect(combineChecks([run('completed', 'neutral'), run('completed', 'skipped'), run('completed', 'stale')], []).state).toBe('passing');
  });
  it('timed_out, cancelled and action_required fail, with names + urls collected', () => {
    const r = combineChecks([run('completed', 'timed_out', 'e2e'), run('completed', 'cancelled', 'lint'), run('completed', 'action_required', 'deploy')], []);
    expect(r.state).toBe('failing');
    expect(r.failing.map((f) => f.name)).toEqual(['e2e', 'lint', 'deploy']);
    expect(r.failing[0]!.url).toBe('https://x/run');
  });
  it('legacy commit statuses fold in (failure/error fail, pending pends)', () => {
    expect(combineChecks([], [{ state: 'failure', context: 'ci/old', target_url: null }]).state).toBe('failing');
    expect(combineChecks([], [{ state: 'pending', context: 'ci/old', target_url: null }]).state).toBe('pending');
    expect(combineChecks([], [{ state: 'success', context: 'ci/old', target_url: null }]).state).toBe('passing');
  });
});

describe('github provider', () => {
  it('resolves the PR from a pr link and classifies merged + green head checks', async () => {
    const fetchJson = fakeFetch([
      ['/pulls/42', { body: ghPr({ merged: true, state: 'closed' }) }],
      ['/commits/headsha/check-runs', { body: { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null, details_url: null }] } }],
      ['/commits/headsha/status', { body: { statuses: [] } }],
    ]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const r = await p.check(ghRemote, 'feature/x', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false });
    expect(r.pr).toMatchObject({ id: '#42', state: 'merged' });
    expect(r.checks.state).toBe('passing');
  });

  it('falls back to head-branch search and prefers a merged PR over a newer closed one', async () => {
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ number: 50, state: 'closed', merged_at: null }), ghPr({ number: 42, state: 'closed', merged_at: '2026-01-01T00:00:00Z' })] }],
      ['/commits/headsha/check-runs', { body: { check_runs: [] } }],
      ['/commits/headsha/status', { body: { statuses: [] } }],
    ]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const r = await p.check(ghRemote, 'feature/x', null, { postMergeChecks: false });
    expect(r.pr).toMatchObject({ id: '#42', state: 'merged' });
    expect(r.checks.state).toBe('none');
  });

  it('no PR found → pr null, checks unknown', async () => {
    const fetchJson = fakeFetch([['/pulls?head=', { body: [] }]]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const r = await p.check(ghRemote, 'feature/x', null, { postMergeChecks: false });
    expect(r.pr).toBeNull();
    expect(r.checks.state).toBe('unknown');
  });

  it('classifies an open PR with merge conflicts without waiting for CI', async () => {
    const fetchJson = fakeFetch([
      ['/pulls/42', { body: ghPr({ mergeable: false, mergeable_state: 'dirty' }) }],
    ]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const r = await p.check(ghRemote, 'feature/x', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false });
    expect(r.pr).toMatchObject({ id: '#42', state: 'open', mergeConflict: { detail: 'GitHub reports mergeable_state=dirty' } });
    expect(r.checks).toMatchObject({ state: 'failing', failing: [{ name: 'merge conflict', url: 'https://github.com/acme/widgets/pull/42' }] });
    expect(fetchJson.calls).toHaveLength(1);
  });

  it('describeFailures lifts check-run output for the failing runs only', async () => {
    const fetchJson = fakeFetch([['/commits/headsha/check-runs', { body: { check_runs: [
      { name: 'build', status: 'completed', conclusion: 'failure', html_url: null, details_url: null, output: { title: 'Build failed', summary: 'NU1903 Microsoft.OpenApi 2.0.0' } },
      { name: 'lint', status: 'completed', conclusion: 'success', html_url: null, details_url: null, output: { summary: 'all good' } },
    ] } }]]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const result: DeliveryCheckResult = {
      pr: { id: '#42', url: 'x', state: 'open', headSha: 'headsha', mergeCommitSha: 'mergesha' },
      checks: { state: 'failing', failing: [{ name: 'build', url: null }] },
    };
    const errors = await p.describeFailures!(ghRemote, result, { postMergeChecks: false });
    expect(errors.some((e) => e.includes('NU1903'))).toBe(true);
    expect(errors.some((e) => e.startsWith('build:'))).toBe(true);
    expect(errors.some((e) => e.includes('all good'))).toBe(false); // passing run excluded
  });

  it('postMergeChecks moves a merged PR\'s check target to the merge commit', async () => {
    const fetchJson = fakeFetch([
      ['/pulls/42', { body: ghPr({ merged: true, state: 'closed' }) }],
      ['/commits/mergesha/check-runs', { body: { check_runs: [{ name: 'post', status: 'in_progress', conclusion: null, html_url: null, details_url: null }] } }],
      ['/commits/mergesha/status', { body: { statuses: [] } }],
    ]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    const r = await p.check(ghRemote, 'feature/x', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: true });
    expect(r.checks.state).toBe('pending');
  });

  it('rate limit (403 + remaining 0) throws with a pause anchored to x-ratelimit-reset', async () => {
    const reset = 1_900_000_000; // epoch seconds
    const fetchJson = fakeFetch([['/pulls/42', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }]]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    await expect(p.check(ghRemote, 'b', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.pauseUntilMs === reset * 1000,
    );
  });

  it('a plain 500 throws without a global pause', async () => {
    const fetchJson = fakeFetch([['/pulls/42', { status: 500 }]]);
    const p = makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
    await expect(p.check(ghRemote, 'b', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.pauseUntilMs === null,
    );
  });
});

describe('combineAdoStatuses', () => {
  it('failed/error fail; pending/notSet pend; empty is none; else passing', () => {
    expect(combineAdoStatuses([{ state: 'failed', context: { name: 'CI' }, targetUrl: 'https://x' }]).state).toBe('failing');
    expect(combineAdoStatuses([{ state: 'succeeded' }, { state: 'pending' }]).state).toBe('pending');
    expect(combineAdoStatuses([]).state).toBe('none');
    expect(combineAdoStatuses([{ state: 'succeeded' }, { state: 'notApplicable' }]).state).toBe('passing');
  });
});

describe('azdo provider', () => {
  const adoPr = (over: Partial<Record<string, unknown>> = {}) => ({
    pullRequestId: 7,
    status: 'active',
    lastMergeSourceCommit: { commitId: 'srcsha' },
    lastMergeCommit: { commitId: 'mrgsha' },
    ...over,
  });

  it('searches by source ref, prefers completed, and maps completed → merged', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests?searchCriteria.sourceRefName=', { body: { value: [adoPr({ pullRequestId: 9, status: 'abandoned' }), adoPr({ status: 'completed' })] } }],
      ['/pullRequests/7/statuses', { body: { value: [{ state: 'succeeded', context: { name: 'Build' } }] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', null, { postMergeChecks: false });
    expect(r.pr).toMatchObject({ id: '!7', state: 'merged' });
    expect(r.pr!.url).toBe('https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7');
    expect(r.checks.state).toBe('passing');
  });

  it('a merged PR with a lingering pending/notSet status → passing (stale merge-gate, no stranding)', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests/7?api-version', { body: adoPr({ status: 'completed' }) }],
      ['/pullRequests/7/statuses', { body: { value: [{ state: 'succeeded', context: { name: 'Build' } }, { state: 'notSet', context: { name: 'optional' } }] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7', { postMergeChecks: true });
    expect(r.pr).toMatchObject({ state: 'merged' });
    expect(r.checks.state).toBe('passing'); // stale pending downgraded → the watcher will complete it
  });

  it('a merged PR with a genuinely failed status stays failing (bounces, not done)', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests/7?api-version', { body: adoPr({ status: 'completed' }) }],
      ['/pullRequests/7/statuses', { body: { value: [{ state: 'failed', context: { name: 'Build' }, targetUrl: 'https://x' }] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7', { postMergeChecks: true });
    expect(r.checks.state).toBe('failing');
  });

  it('an OPEN PR with a pending status still waits (only merged downgrades)', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests/7?api-version', { body: adoPr({ status: 'active' }) }],
      ['/pullRequests/7/statuses', { body: { value: [{ state: 'pending', context: { name: 'Build' } }] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7', { postMergeChecks: true });
    expect(r.pr).toMatchObject({ state: 'open' });
    expect(r.checks.state).toBe('pending'); // unmerged → genuinely gating, keep waiting
  });

  it('classifies an active PR with merge conflicts without waiting for statuses', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests/7?api-version', { body: adoPr({ status: 'active', mergeStatus: 'conflicts', mergeFailureMessage: 'Conflicts in src/app.ts' }) }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7', { postMergeChecks: false });
    expect(r.pr).toMatchObject({ id: '!7', state: 'open', mergeConflict: { detail: 'Conflicts in src/app.ts' } });
    expect(r.checks).toMatchObject({ state: 'failing', failing: [{ name: 'merge conflict', url: 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7' }] });
    expect(fetchJson.calls).toHaveLength(1);
  });

  it('resolves a pr link directly and maps abandoned → closed', async () => {
    const fetchJson = fakeFetch([
      ['/pullrequests/7?api-version', { body: adoPr({ status: 'abandoned' }) }],
      ['/pullRequests/7/statuses', { body: { value: [] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const r = await p.check(adoRemote, 'feature/x', 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7', { postMergeChecks: false });
    expect(r.pr).toMatchObject({ state: 'closed' });
    expect(r.checks.state).toBe('none');
  });

  it('429 throws with a retry-after pause', async () => {
    const fetchJson = fakeFetch([['/pullrequests?', { status: 429, headers: { 'retry-after': '30' } }]]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    await expect(p.check(adoRemote, 'b', null, { postMergeChecks: false })).rejects.toSatisfy(
      (e: unknown) => e instanceof ProviderHttpError && e.pauseUntilMs !== null,
    );
  });

  it('parseBuildId reads the id from a results url and a vstfs link, null otherwise', () => {
    expect(parseBuildId('https://dev.azure.com/o/p/_build/results?buildId=123&view=results')).toBe('123');
    expect(parseBuildId('vstfs:///Build/Build/456')).toBe('456');
    expect(parseBuildId('https://external/status')).toBeNull();
    expect(parseBuildId(null)).toBeNull();
  });

  it('describeFailures pulls error issues from the failing build timeline (warnings excluded)', async () => {
    const fetchJson = fakeFetch([
      ['/_apis/build/builds/555/timeline', { body: { records: [
        { issues: [{ type: 'error', message: "NU1903: Package 'Microsoft.OpenApi' 2.0.0 vulnerability" }, { type: 'warning', message: 'noise' }] },
        { issues: [{ type: 'error', message: 'CS1061: MaterialProjectPurchase has no WarehouseID' }] },
      ] } }],
    ]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const result: DeliveryCheckResult = {
      pr: { id: '!7', url: 'x', state: 'open', headSha: null, mergeCommitSha: null },
      checks: { state: 'failing', failing: [{ name: 'CE-Adapter - Build', url: 'https://dev.azure.com/acme/Widgets/_build/results?buildId=555' }] },
    };
    const errors = await p.describeFailures!(adoRemote, result, { postMergeChecks: false });
    expect(errors).toContain("NU1903: Package 'Microsoft.OpenApi' 2.0.0 vulnerability");
    expect(errors).toContain('CS1061: MaterialProjectPurchase has no WarehouseID');
    expect(errors.some((e) => e.includes('noise'))).toBe(false);
  });

  it('describeFailures degrades to [] when the build timeline is forbidden (PAT lacks Build read)', async () => {
    const fetchJson = fakeFetch([['/_apis/build/builds/555/timeline', { status: 203, body: '<html/>' }]]);
    const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
    const result: DeliveryCheckResult = {
      pr: { id: '!7', url: 'x', state: 'open', headSha: null, mergeCommitSha: null },
      checks: { state: 'failing', failing: [{ name: 'Build', url: 'https://x/_build/results?buildId=555' }] },
    };
    expect(await p.describeFailures!(adoRemote, result, { postMergeChecks: false })).toEqual([]);
  });
});
