import { describe, it, expect } from 'vitest';
import { isFailureMarker, parseFailureComment } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import { deliverTask, fakeFetch, ghPr, makeConfig, makeCore, makeDeps } from './helpers.js';

const green = { check_runs: [{ name: 'build', status: 'completed', conclusion: 'success', html_url: null, details_url: null }] };
const red = { check_runs: [{ name: 'build', status: 'completed', conclusion: 'failure', html_url: 'https://gh/run/1', details_url: null }] };
const running = { check_runs: [{ name: 'build', status: 'in_progress', conclusion: null, html_url: null, details_url: null }] };

describe('watcher tick', () => {
  it('merged PR + green checks → done, with the why in the status trail', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ merged_at: '2026-01-01T00:00:00Z', state: 'closed' })] }],
      ['/check-runs', { body: green }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('done');
    const close = t.activity.filter((a) => a.type === 'status_change').at(-1)!;
    expect(close).toMatchObject({ actor: 'agent', toStatus: 'done' });
    expect(close.body).toContain('PR #42 merged');
  });

  it('failing checks → queued with exactly one parseable failure/v1 ci_failed comment', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr()] }],
      ['/check-runs', { body: red }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('queued');
    expect(t.claimedBy).toBeNull();
    const failures = t.activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body));
    expect(failures).toHaveLength(1);
    const parsed = parseFailureComment(failures[0]!.body)!;
    expect(parsed).toMatchObject({ reason: 'ci_failed', source: 'watcher' });
    expect(failures[0]!.body).toContain('https://gh/run/1');
    expect(t.failure).toMatchObject({ reason: 'ci_failed', skipListed: false });
    // a second tick must not double-bounce or double-comment (the task left 'delivering')
    await w.tick();
    expect(core.getTask(key).activity.filter((a) => a.type === 'comment' && isFailureMarker(a.body))).toHaveLength(1);
  });

  it('PR closed without merge → queued with pr_closed', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ state: 'closed', merged_at: null })] }],
      ['/check-runs', { body: green }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('queued');
    expect(t.failure).toMatchObject({ reason: 'pr_closed' });
  });

  it('open PR with running checks → records state, stays delivering, version bumps only on change', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr()] }],
      ['/check-runs', { body: running }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.delivery).toMatchObject({ prState: 'open', checksState: 'pending', prId: '#42' });
    expect(t.delivery!.checkedAt).not.toBeNull();
    const v1 = core.getVersion();
    await w.tick(); // same observation — checked_at moves, version must not
    expect(core.getVersion()).toBe(v1);
  });

  it('merged but checks still pending → keeps waiting (no premature done)', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ merged_at: '2026-01-01T00:00:00Z', state: 'closed' })] }],
      ['/check-runs', { body: running }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    expect(core.getTask(key).status).toBe('delivering');
  });

  it('no PR yet → records not_found and waits', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([['/pulls?head=', { body: [] }]]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    const t = core.getTask(key);
    expect(t.status).toBe('delivering');
    expect(t.delivery).toMatchObject({ prState: 'not_found' });
  });

  it('provider failure → exponential backoff (no re-poll inside the window), no transition', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    let clock = 1_000_000;
    const fetchJson = fakeFetch([['/pulls?head=', { status: 500 }]]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson, { now: () => clock }));
    await w.tick();
    expect(core.getTask(key).status).toBe('delivering');
    const callsAfterFirst = fetchJson.calls.length;
    await w.tick(); // still inside the backoff window → no new provider call
    expect(fetchJson.calls.length).toBe(callsAfterFirst);
    clock += 3 * 60_000; // past the backoff (pollSeconds 60 → first backoff 120s)
    await w.tick();
    expect(fetchJson.calls.length).toBeGreaterThan(callsAfterFirst);
  });

  it('a rate-limit response pauses ALL polling until the reset', async () => {
    const core = makeCore();
    deliverTask(core, 'task one');
    let clock = 1_000_000;
    const reset = Math.ceil((clock + 60_000) / 1000);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson, { now: () => clock }));
    await w.tick();
    const afterFirst = fetchJson.calls.length;
    await w.tick(); // paused — no provider traffic at all
    expect(fetchJson.calls.length).toBe(afterFirst);
    clock = reset * 1000 + 1;
    await w.tick();
    expect(fetchJson.calls.length).toBeGreaterThan(afterFirst);
  });

  it('ignores workspaces it does not serve', async () => {
    const core = makeCore();
    deliverTask(core);
    const fetchJson = fakeFetch([]);
    const w = new Watcher(makeConfig({ workspaces: ['other'] }), makeDeps(core, fetchJson));
    await w.tick();
    expect(fetchJson.calls).toHaveLength(0);
  });

  it('serves every workspace when config.workspaces is omitted (opt-out default)', async () => {
    const core = makeCore();
    const key = deliverTask(core); // lands in the seeded 'default' workspace
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ merged_at: '2026-01-01T00:00:00Z', state: 'closed' })] }],
      ['/check-runs', { body: green }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig({ workspaces: undefined }), makeDeps(core, fetchJson));
    await w.tick();
    expect(core.getTask(key).status).toBe('done'); // examined + closed (contrast the pinned-['other'] skip above)
  });

  it('excludeWorkspaces skips a delivering task even in serve-all mode', async () => {
    const core = makeCore();
    deliverTask(core); // in 'default'
    const fetchJson = fakeFetch([]);
    const w = new Watcher(makeConfig({ workspaces: undefined, excludeWorkspaces: ['default'] }), makeDeps(core, fetchJson));
    await w.tick();
    expect(fetchJson.calls).toHaveLength(0);
  });

  it('self-heals a raw drag into delivering (no seeded row) via the origin resolver', async () => {
    const core = makeCore();
    const t = core.createTask({ title: 'Dragged', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w' });
    core.submitResult(t.key, { summary: 'ok' });
    // raw human move (not approve) — no delivery row seeded
    core.updateStatus(t.key, 'delivering', 'human');
    expect(core.getDelivery(t.key)).toBeNull();
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ merged_at: '2026-01-01T00:00:00Z', state: 'closed' })] }],
      ['/check-runs', { body: green }],
      ['/status', { body: { statuses: [] } }],
    ]);
    const w = new Watcher(makeConfig(), makeDeps(core, fetchJson));
    await w.tick();
    expect(core.getTask(t.key).status).toBe('done');
  });

  it('a task with no branch dragged into delivering is warned once and left for the human', async () => {
    const core = makeCore();
    const t = core.createTask({ title: 'No branch', spec: 's', acceptanceCriteria: 'a' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: 'w' });
    core.submitResult(t.key, { summary: 'ok' });
    core.updateStatus(t.key, 'delivering', 'human');
    const warnings: string[] = [];
    const fetchJson = fakeFetch([]);
    const deps = makeDeps(core, fetchJson, { resolveOrigin: () => null });
    deps.console = { log: () => {}, warn: (m: unknown) => warnings.push(String(m)), error: () => {} };
    const w = new Watcher(makeConfig(), deps);
    await w.tick();
    await w.tick();
    expect(core.getTask(t.key).status).toBe('delivering');
    expect(warnings.filter((m) => m.includes(t.key))).toHaveLength(1);
    expect(fetchJson.calls).toHaveLength(0);
  });

  it('losing a race to a human move is settled, not an error', async () => {
    const core = makeCore();
    const key = deliverTask(core);
    const fetchJson = fakeFetch([
      ['/pulls?head=', { body: [ghPr({ merged_at: '2026-01-01T00:00:00Z', state: 'closed' })] }],
      ['/check-runs', { body: green }],
      ['/status', { body: { statuses: [] } }],
    ]);
    // hijack the observation write to sneak a human force-complete in between it and completeDelivery
    const hijacked = {
      ...core,
      recordDeliveryCheck: (k: string, o: Parameters<typeof core.recordDeliveryCheck>[1]) => {
        const r = core.recordDeliveryCheck(k, o);
        core.updateStatus(k, 'done', 'human');
        return r;
      },
    };
    const w = new Watcher(makeConfig(), makeDeps(hijacked as typeof core, fetchJson));
    await expect(w.tick()).resolves.toBeUndefined();
    expect(core.getTask(key).status).toBe('done');
  });

  it('records a watcher heartbeat with the delivering count', async () => {
    const core = makeCore();
    deliverTask(core);
    const fetchJson = fakeFetch([['/pulls?head=', { body: [] }]]);
    const w = new Watcher(makeConfig({ name: 'watcher-test' }), makeDeps(core, fetchJson));
    await w.tick();
    const sup = core.listSupervisors().find((s) => s.name === 'watcher-test')!;
    expect(sup).toMatchObject({ kind: 'watcher', inFlight: 1, capacity: 0 });
  });
});
