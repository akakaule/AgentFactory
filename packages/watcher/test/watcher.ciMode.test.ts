import { describe, it, expect } from 'vitest';
import { isFailureMarker, type CiMode } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { FetchJson } from '../src/types.js';
import { ADO_ORIGIN, GH_ORIGIN, deliverTask, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

// AF-173: the workspace's ciMode decides which checks judge a delivery — 'required' only the named
// requiredChecks, 'none' no checks at all, 'legacy'/unset every check (today's rule) — the same
// on GitHub and Azure DevOps.

type Check = { name: string; state: 'passing' | 'failing' | 'pending' };

/** A GitHub host with one open PR whose head carries `checks` as check runs. */
function github(checks: Check[]): FetchJson {
  const runs = checks.map((c) => ({
    name: c.name, status: c.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: c.state === 'pending' ? null : c.state === 'passing' ? 'success' : 'failure',
    html_url: `https://gh/run/${c.name}`, details_url: null,
  }));
  return async (url: string) => {
    const body = url.includes('/pulls?head=') ? [ghPr()]
      : url.includes('/check-runs') ? { check_runs: runs }
      : url.includes('/status') ? { statuses: [] }
      : null;
    if (body === null) throw new Error(`unrouted ${url}`);
    return { status: 200, headers: {}, body };
  };
}

/** An Azure DevOps host with one active PR whose statuses are `checks`. */
function azdo(checks: Check[]): FetchJson {
  const pr = { pullRequestId: 7, status: 'active', description: '', repository: { id: 'repo-guid', project: { id: 'proj-guid' } },
    lastMergeSourceCommit: { commitId: 'srcsha' }, lastMergeCommit: null };
  const statuses = checks.map((c) => ({
    state: c.state === 'passing' ? 'succeeded' : c.state === 'failing' ? 'failed' : 'pending',
    context: { name: c.name }, targetUrl: `https://ado/build/${c.name}`,
  }));
  return async (url: string) => {
    const body = url.includes('/pullrequests?searchCriteria') ? { value: [pr] }
      : url.includes('/pullrequests/7?') ? pr
      : url.includes('/pullRequests/7/statuses') ? { value: statuses }
      : url.includes('/policy/evaluations') ? { value: [] }
      : url.includes('/timeline') ? { records: [] }
      : null;
    if (body === null) throw new Error(`unrouted ${url}`);
    return { status: 200, headers: {}, body };
  };
}

const hosts = [
  { host: 'GitHub', origin: GH_ORIGIN, fetch: github },
  { host: 'Azure DevOps', origin: ADO_ORIGIN, fetch: azdo },
] as const;

async function poll(host: (typeof hosts)[number], profile: { ciMode: CiMode | null; requiredChecks?: string[] | null }, checks: Check[]) {
  const core = makeCore(host.origin);
  core.updateWorkspace('default', { ciMode: profile.ciMode, requiredChecks: profile.requiredChecks ?? null });
  const key = deliverTask(core);
  const before = core.getTask(key).activity.filter((a) => a.type === 'comment').length;
  await new Watcher(makeConfig(), makeDeps(core, host.fetch(checks), { resolveOrigin: () => host.origin })).tick();
  const task = core.getTask(key);
  const failureNotes = task.activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body));
  const comments = task.activity.filter((a) => a.type === 'comment').length - before;
  return { task, failureNotes, comments };
}

describe.each(hosts)('ciMode on $host', (host) => {
  it('required: a failing required check bounces once', async () => {
    const { task, failureNotes } = await poll(host, { ciMode: 'required', requiredChecks: ['build'] }, [{ name: 'build', state: 'failing' }]);
    expect(task.status).toBe('queued');
    expect(failureNotes).toHaveLength(1);
  });

  it('required: a missing required check waits and is listed as missing', async () => {
    const { task, comments } = await poll(host, { ciMode: 'required', requiredChecks: ['build'] }, [{ name: 'lint', state: 'passing' }]);
    expect(task.status).toBe('delivering');
    expect(comments).toBe(0);
    expect(task.delivery!.checksState).toBe('pending');
    expect(task.delivery!.failing).toEqual([{ name: 'build', url: null, missing: true }]);
  });

  it('required: a failing check outside requiredChecks never bounces', async () => {
    const { task, comments } = await poll(host, { ciMode: 'required', requiredChecks: ['build'] },
      [{ name: 'build', state: 'passing' }, { name: 'lint', state: 'failing' }]);
    expect(task.status).toBe('delivering');
    expect(comments).toBe(0);
    expect(task.delivery!.checksState).toBe('passing');
  });

  it('none: checks are ignored and recorded as no CI by choice', async () => {
    const { task, comments } = await poll(host, { ciMode: 'none' }, [{ name: 'build', state: 'failing' }]);
    expect(task.status).toBe('delivering');
    expect(comments).toBe(0);
    expect(task.delivery).toMatchObject({ checksState: 'none', ciMode: 'none', failing: [] });
  });

  it('legacy (unset): any failing check bounces once, as before', async () => {
    const { task, failureNotes } = await poll(host, { ciMode: null }, [{ name: 'lint', state: 'failing' }]);
    expect(task.status).toBe('queued');
    expect(failureNotes).toHaveLength(1);
    expect(task.delivery!.ciMode).toBeUndefined();
  });

  it("legacy (explicit): behaves like unset", async () => {
    const { task, failureNotes } = await poll(host, { ciMode: 'legacy' }, [{ name: 'lint', state: 'failing' }]);
    expect(task.status).toBe('queued');
    expect(failureNotes).toHaveLength(1);
  });
});
