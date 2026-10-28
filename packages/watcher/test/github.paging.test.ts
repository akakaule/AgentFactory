import { describe, it, expect } from 'vitest';
import { makeGitHubProvider } from '../src/providers/github.js';
import type { FetchJson } from '../src/types.js';
import { parseRemoteUrl } from '@agentfactory/core';
import { ghPr, GH_ORIGIN } from './helpers.js';

const ghRemote = parseRemoteUrl(GH_ORIGIN)!;

const passing = (i: number) => ({ name: `r${i}`, status: 'completed', conclusion: 'success', html_url: null, details_url: null });

/** Serves `pages[n-1]` for `&page=n` on check-runs (an empty page past the end); counts those requests. */
function pagedFetch(pageOf: (page: number) => unknown[]): FetchJson & { runCalls: string[] } {
  const runCalls: string[] = [];
  const fn = (async (url: string) => {
    if (url.includes('/check-runs')) {
      runCalls.push(url);
      const page = Number(/[?&]page=(\d+)/.exec(url)?.[1] ?? '1');
      return { status: 200, headers: {}, body: { check_runs: pageOf(page) } };
    }
    if (url.includes('/pulls/42')) return { status: 200, headers: {}, body: ghPr() };
    if (url.includes('/status')) return { status: 200, headers: {}, body: { statuses: [] } };
    throw new Error(`unrouted url ${url}`);
  }) as FetchJson & { runCalls: string[] };
  fn.runCalls = runCalls;
  return fn;
}

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, k) => from + k);

/** 100 passing runs on page 1, 50 on page 2 with r150 failing. */
const twoPages = (page: number): unknown[] => {
  if (page === 1) return range(1, 100).map(passing);
  if (page === 2) return range(101, 150).map((i) => (i === 150
    ? { name: 'r150', status: 'completed', conclusion: 'failure', html_url: 'https://x/r150', details_url: null, output: { title: 'Build failed', summary: 'tsc error' } }
    : passing(i)));
  return [];
};

const provider = (fetchJson: FetchJson) => makeGitHubProvider({ fetchJson, token: 'tok', apiBase: 'https://api.github.com', now: () => 0 });
const check = (fetchJson: FetchJson) =>
  provider(fetchJson).check(ghRemote, 'feature/x', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false });

describe('github check-run paging', () => {
  it('follows page 2 and sees a failing run there', async () => {
    const f = pagedFetch(twoPages);
    const r = await check(f);
    expect(f.runCalls.some((u) => u.includes('&page=2'))).toBe(true);
    expect(r.checks.state).toBe('failing');
    expect(r.checks.failing).toEqual([{ name: 'r150', url: 'https://x/r150' }]);
  });

  it('makes exactly one request when page 1 has fewer than 100 runs', async () => {
    const f = pagedFetch((p) => (p === 1 ? range(1, 30).map(passing) : []));
    await check(f);
    expect(f.runCalls).toHaveLength(1);
  });

  it('makes exactly two requests when page 1 has exactly 100 runs and page 2 is empty', async () => {
    const f = pagedFetch((p) => (p === 1 ? range(1, 100).map(passing) : []));
    const r = await check(f);
    expect(f.runCalls).toHaveLength(2);
    expect(r.checks.state).toBe('passing');
  });

  it('stops after 10 pages when every page is full', async () => {
    const f = pagedFetch(() => range(1, 100).map(passing));
    await check(f);
    expect(f.runCalls).toHaveLength(10);
  });

  it('describeFailures lifts the excerpt of a failing run on page 2', async () => {
    const f = pagedFetch(twoPages);
    const p = provider(f);
    const result = await p.check(ghRemote, 'feature/x', 'https://github.com/acme/widgets/pull/42', { postMergeChecks: false });
    const errors = await p.describeFailures!(ghRemote, result, { postMergeChecks: false });
    expect(errors).toEqual([expect.stringContaining('r150: Build failed')]);
  });
});
