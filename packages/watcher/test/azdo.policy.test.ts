import { describe, it, expect } from 'vitest';
import { makeAzdoProvider } from '../src/providers/azdo.js';
import { parseRemoteUrl } from '@agentfactory/core';
import { fakeFetch, ADO_ORIGIN } from './helpers.js';

const adoRemote = parseRemoteUrl(ADO_ORIGIN)!;
const PR7 = 'https://dev.azure.com/acme/Widgets/_git/widgets/pullrequest/7';

const adoPr = (over: Partial<Record<string, unknown>> = {}) => ({
  pullRequestId: 7,
  status: 'active',
  lastMergeSourceCommit: { commitId: 'srcsha' },
  repository: { id: 'repo-guid', project: { id: 'proj-guid' } },
  ...over,
});

const evaluation = (over: { status?: string; isBlocking?: boolean; type?: string; name?: string } = {}) => ({
  status: over.status ?? 'rejected',
  configuration: {
    isBlocking: over.isBlocking ?? true,
    type: { displayName: over.type ?? 'Build' },
    settings: { displayName: over.name ?? 'CI' },
  },
});

async function check(evaluations: unknown[], statuses: unknown[] = [], pr: unknown = adoPr()) {
  const fetchJson = fakeFetch([
    ['/pullrequests/7?api-version', { body: pr }],
    ['/pullRequests/7/statuses', { body: { value: statuses } }],
    ['/_apis/policy/evaluations?', { body: { value: evaluations } }],
    ['/_apis/projects/', { body: { id: 'proj-from-lookup' } }],
  ]);
  const p = makeAzdoProvider({ fetchJson, pat: 'pat', apiVersion: '7.1' });
  const r = await p.check(adoRemote, 'feature/x', PR7, { postMergeChecks: false });
  return { r, calls: fetchJson.calls };
}

describe('azdo provider: blocking build-policy evaluations', () => {
  it('a rejected blocking build policy with no PR statuses is failing, named by its display name', async () => {
    const { r, calls } = await check([evaluation({ status: 'rejected' })]);
    expect(r.checks).toEqual({ state: 'failing', failing: [{ name: 'CI', url: null }] });
    const url = calls.find((u) => u.includes('/_apis/policy/evaluations?'))!;
    expect(url).toContain('https://dev.azure.com/acme/Widgets/_apis/policy/evaluations?');
    expect(url).toContain(`artifactId=${encodeURIComponent('vstfs:///CodeReview/CodeReviewId/proj-guid/7')}`);
    expect(url).toContain('api-version=7.1-preview.1');
  });

  it('a queued blocking build policy is pending', async () => {
    expect((await check([evaluation({ status: 'queued' })])).r.checks.state).toBe('pending');
  });

  it('a running blocking build policy is pending', async () => {
    expect((await check([evaluation({ status: 'running' })])).r.checks.state).toBe('pending');
  });

  it('an approved blocking build policy is passing', async () => {
    expect((await check([evaluation({ status: 'approved' })])).r.checks.state).toBe('passing');
  });

  it('a non-blocking build policy is ignored', async () => {
    expect((await check([evaluation({ status: 'rejected', isBlocking: false })])).r.checks.state).toBe('none');
  });

  it('a non-build policy type is ignored', async () => {
    const r = (await check([evaluation({ status: 'rejected', type: 'Minimum number of reviewers' })])).r;
    expect(r.checks.state).toBe('none');
  });

  it('a policy and a PR status with the same name count once, failing wins', async () => {
    const { r } = await check([evaluation({ status: 'rejected' })], [{ context: { name: 'CI' }, state: 'succeeded' }]);
    expect(r.checks.state).toBe('failing');
    expect(r.checks.failing).toEqual([{ name: 'CI', url: null }]);
  });

  it('a failing PR status keeps its link over a same-named rejected policy', async () => {
    const { r } = await check([evaluation({ status: 'rejected' })], [{ context: { name: 'CI' }, state: 'failed', targetUrl: 'https://b' }]);
    expect(r.checks.failing).toEqual([{ name: 'CI', url: 'https://b' }]);
  });

  it('looks the project id up when the PR payload lacks it', async () => {
    const { r, calls } = await check([evaluation({ status: 'rejected' })], [], adoPr({ repository: { id: 'repo-guid' } }));
    expect(r.checks.state).toBe('failing');
    const url = calls.find((u) => u.includes('/_apis/policy/evaluations?'))!;
    expect(url).toContain(encodeURIComponent('vstfs:///CodeReview/CodeReviewId/proj-from-lookup/7'));
  });
});
