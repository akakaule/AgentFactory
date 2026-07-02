import { openCore, type Core } from '@agentfactory/core';
import { parseConfig, type WatcherConfig } from '../src/config.js';
import type { FetchJson, FetchResponse, WatcherDeps } from '../src/types.js';

export const GH_ORIGIN = 'https://github.com/acme/widgets.git';
export const ADO_ORIGIN = 'https://dev.azure.com/acme/Widgets/_git/widgets';

/** A real in-memory core whose approve routes to delivering via the injected fake origin. */
export function makeCore(origin: string | null = GH_ORIGIN): Core {
  return openCore(':memory:', { resolveOrigin: () => origin });
}

/** create → queue → claim (names the branch) → submit → approve ⇒ 'delivering' with a seeded row. */
export function deliverTask(core: Core, title = 'Ship the widget'): string {
  const t = core.createTask({ title, spec: 'spec', acceptanceCriteria: 'ac' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  core.submitResult(t.key, { summary: 'done' });
  const approved = core.reviewApprove(t.key);
  if (approved.status !== 'delivering') throw new Error(`expected delivering, got ${approved.status}`);
  return t.key;
}

export function makeConfig(overrides: Partial<WatcherConfig> = {}): WatcherConfig {
  return { ...parseConfig({ db: ':memory:', workspaces: ['default'] }), ...overrides };
}

/** Routes fetches by first matching URL substring; unmatched URLs throw (a test writing bug). */
export function fakeFetch(routes: Array<[match: string, res: Partial<FetchResponse>]>): FetchJson & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    const hit = routes.find(([m]) => url.includes(m));
    if (!hit) throw new Error(`fakeFetch: unrouted url ${url}`);
    return { status: 200, headers: {}, body: null, ...hit[1] };
  }) as FetchJson & { calls: string[] };
  fn.calls = calls;
  return fn;
}

export function makeDeps(core: Core, fetchJson: FetchJson, overrides: Partial<WatcherDeps> = {}): WatcherDeps {
  return {
    core,
    fetchJson,
    resolveOrigin: () => GH_ORIGIN,
    env: { GITHUB_TOKEN: 'tok', AZDO_PAT: 'pat' },
    now: () => Date.now(),
    console: { log: () => {}, warn: () => {}, error: () => {} },
    ...overrides,
  };
}

/** Canned GitHub API bodies. */
export function ghPr(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    number: 42,
    html_url: 'https://github.com/acme/widgets/pull/42',
    state: 'open',
    merged: false,
    merged_at: null,
    head: { sha: 'headsha' },
    merge_commit_sha: 'mergesha',
    ...overrides,
  };
}
