import { describe, it, expect } from 'vitest';
import { Watcher } from '../src/watcher.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { deliverTask, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

/** AF-187: a workspace's createPullRequests (when set) overrides the watcher config's flag. */

const GH_REPO = 'https://api.github.com/repos/acme/widgets';

function github(): FetchJson & { posts: number } {
  const fn = (async (url, init) => {
    const method = init.method ?? 'GET';
    const ok = (body: unknown, status = 200): FetchResponse => ({ status, headers: {}, body });
    if (method === 'GET' && url === GH_REPO) return ok({ default_branch: 'main' });
    if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return ok([]);
    if (method === 'POST' && url === `${GH_REPO}/pulls`) { fn.posts++; return ok(ghPr({ number: 43, html_url: 'https://github.com/acme/widgets/pull/43' }), 201); }
    if (method === 'GET' && url.includes('/check-runs')) return ok({ check_runs: [] });
    if (method === 'GET' && url.endsWith('/status')) return ok({ statuses: [] });
    throw new Error(`unrouted ${method} ${url}`);
  }) as FetchJson & { posts: number };
  fn.posts = 0;
  return fn;
}

async function createRequests(config: boolean, workspace: boolean | null): Promise<number> {
  const core = makeCore();
  if (workspace !== null) core.updateWorkspace('default', { createPullRequests: workspace });
  deliverTask(core);
  expect(core.getWorkspace('default').createPullRequests).toBe(workspace);
  const fetchJson = github();
  await new Watcher(makeConfig({ createPullRequests: config }), makeDeps(core, fetchJson)).tick();
  return fetchJson.posts;
}

describe('per-workspace PR creation switch', () => {
  it('workspace off beats config on: no create-PR request', async () => {
    expect(await createRequests(true, false)).toBe(0);
  });
  it('workspace on beats config off: exactly one create-PR request', async () => {
    expect(await createRequests(false, true)).toBe(1);
  });
  it('workspace unset follows the config', async () => {
    expect(await createRequests(true, null)).toBe(1);
    expect(await createRequests(false, null)).toBe(0);
  });
});
