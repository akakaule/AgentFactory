import { describe, it, expect } from 'vitest';
import type { Core } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { ADO_ORIGIN, deliverTask, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

/**
 * AF-174: the watcher opens a delivery's PR against the workspace's configured base branch
 * (AF-151 repository profile) and falls back to the host's default branch when none is set.
 */

interface Call { method: string; url: string; body: unknown }
type Handler = (method: string, url: string) => Partial<FetchResponse> | undefined;

function apiFake(handler: Handler): FetchJson & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    const res = handler(method, url);
    if (!res) throw new Error(`apiFake: unrouted ${method} ${url}`);
    return { status: 200, headers: {}, body: null, ...res };
  }) as FetchJson & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const GH_REPO = 'https://api.github.com/repos/o/r';
const GH_ORIGIN = 'https://github.com/o/r.git';
const ADO_BASE = 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets';

const github = () => apiFake((method, url) => {
  if (method === 'GET' && url === GH_REPO) return { body: { default_branch: 'main' } };
  if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return { body: [] };
  if (method === 'POST' && url === `${GH_REPO}/pulls`) return { status: 201, body: ghPr({ number: 9, html_url: 'https://github.com/o/r/pull/9' }) };
  if (method === 'GET' && url.includes('/check-runs')) return { body: { check_runs: [] } };
  if (method === 'GET' && url.endsWith('/status')) return { body: { statuses: [] } };
  return undefined;
});

const ado = () => apiFake((method, url) => {
  if (method === 'GET' && url.startsWith(`${ADO_BASE}?`)) return { body: { defaultBranch: 'refs/heads/main' } };
  if (method === 'GET' && url.startsWith(`${ADO_BASE}/pullrequests?searchCriteria`)) return { body: { value: [] } };
  if (method === 'POST' && url.startsWith(`${ADO_BASE}/pullrequests?`)) {
    return { status: 201, body: { pullRequestId: 77, status: 'active', mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: 'src' } } };
  }
  if (method === 'GET' && url.includes('/statuses')) return { body: { value: [] } };
  if (method === 'GET' && url.includes('/_apis/policy/evaluations?')) return { body: { value: [] } };
  if (method === 'GET' && url.includes('/_apis/projects/')) return { body: { id: 'proj-guid' } };
  return undefined;
});

const prPost = (f: { calls: Call[] }) => {
  const posts = f.calls.filter((c) => c.method === 'POST');
  expect(posts).toHaveLength(1);
  return posts[0]!;
};

async function tickWith(core: Core, fetchJson: FetchJson, origin: string): Promise<void> {
  await new Watcher(makeConfig(), makeDeps(core, fetchJson, { resolveOrigin: () => origin })).tick();
}

describe('watcher opens the PR against the workspace base branch', () => {
  it('GitHub: a configured baseBranch is the PR base', async () => {
    const core = makeCore(GH_ORIGIN);
    core.updateWorkspace('default', { baseBranch: 'develop' });
    deliverTask(core);
    const fetchJson = github();
    await tickWith(core, fetchJson, GH_ORIGIN);
    const post = prPost(fetchJson);
    expect(post.url).toBe(`${GH_REPO}/pulls`);
    expect((post.body as { base: string }).base).toBe('develop');
  });

  it('Azure DevOps: a configured baseBranch is the PR target ref', async () => {
    const core = makeCore(ADO_ORIGIN);
    core.updateWorkspace('default', { baseBranch: 'develop' });
    deliverTask(core);
    const fetchJson = ado();
    await tickWith(core, fetchJson, ADO_ORIGIN);
    const post = prPost(fetchJson);
    expect(post.url.startsWith(`${ADO_BASE}/pullrequests?`)).toBe(true);
    expect((post.body as { targetRefName: string }).targetRefName).toBe('refs/heads/develop');
  });

  it('GitHub: no baseBranch → the repository default branch', async () => {
    const core = makeCore(GH_ORIGIN);
    expect(core.listWorkspaces().find((w) => w.name === 'default')!.baseBranch).toBeNull();
    deliverTask(core);
    const fetchJson = github();
    await tickWith(core, fetchJson, GH_ORIGIN);
    expect((prPost(fetchJson).body as { base: string }).base).toBe('main');
  });

  it('Azure DevOps: no baseBranch → the repository default branch', async () => {
    const core = makeCore(ADO_ORIGIN);
    deliverTask(core);
    const fetchJson = ado();
    await tickWith(core, fetchJson, ADO_ORIGIN);
    expect((prPost(fetchJson).body as { targetRefName: string }).targetRefName).toBe('refs/heads/main');
  });
});
