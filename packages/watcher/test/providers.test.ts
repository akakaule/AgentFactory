import { describe, it, expect } from 'vitest';
import { makeGitHubProvider, combineChecks } from '../src/providers/github.js';
import { makeAzdoProvider, combineAdoStatuses } from '../src/providers/azdo.js';
import { ProviderHttpError } from '../src/providers/types.js';
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
});
