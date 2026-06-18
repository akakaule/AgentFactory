import { describe, it, expect, vi } from 'vitest';
import { Notifier, notifierConfigFromEnv, type NotifierCore, type NotifyFetch, type NotifyEvent } from '../../server/notifier.js';
import { buildFailureComment } from '@agentfactory/core';
import type { ActivityFeedRow, SupervisorView, Task } from '@agentfactory/core';

function makeFakeCore() {
  const activity: ActivityFeedRow[] = [];
  const kv = new Map<string, string>();
  let supervisors: SupervisorView[] = [];
  let tasks: Task[] = [];
  let nextId = 1;
  const core: NotifierCore = {
    activitySince: (since, limit = 200) => activity.filter((a) => a.id > since).slice(0, limit),
    latestActivityId: () => (activity.length ? activity[activity.length - 1]!.id : 0),
    getKv: (k) => kv.get(k) ?? null,
    setKv: (k, v) => { kv.set(k, v); },
    listSupervisors: () => supervisors,
    listTasks: (opts) => (opts?.status ? tasks.filter((t) => t.status === opts.status) : tasks),
  };
  return {
    core, kv,
    push: (row: Partial<ActivityFeedRow>) => {
      activity.push({ id: nextId++, taskKey: 'AF-1', taskTitle: 'T', workspace: 'default', type: 'comment', actor: 'agent', toStatus: null, body: '', createdAt: '', ...row });
    },
    setSupervisors: (s: Partial<SupervisorView>[]) => { supervisors = s as SupervisorView[]; },
    setTasks: (t: Partial<Task>[]) => { tasks = t as Task[]; },
  };
}

function makeFakeFetch() {
  const calls: Array<{ url: string; text: string }> = [];
  const fetch: NotifyFetch = async (url, init) => { calls.push({ url, text: (JSON.parse(init.body) as { text: string }).text }); return { ok: true, status: 200 }; };
  return { fetch, calls };
}

const cfg = (events: NotifyEvent[], webhooks = ['http://hook']) => ({ webhooks, events: new Set(events), pollMs: 1000 });
const fail = (over: { reason?: string; attempt?: number; maxAttempts?: number } = {}) =>
  buildFailureComment({ reason: over.reason ?? 'crashed', detail: 'd', source: 'dispatcher', attempt: over.attempt ?? 1, maxAttempts: over.maxAttempts ?? 2 });

describe('Notifier — activity events', () => {
  it('skips history on first run, then alerts on a task entering review', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    fc.push({ type: 'status_change', toStatus: 'in_review' }); // pre-existing — must NOT alert
    const n = new Notifier(cfg(['in_review']), { core: fc.core, fetch: ff.fetch });

    await n.tick(); // first tick initializes the cursor past history
    expect(ff.calls).toHaveLength(0);
    expect(fc.kv.get('notify_cursor')).toBe('1');

    fc.push({ type: 'status_change', toStatus: 'in_review', taskKey: 'AF-2', taskTitle: 'Ship it' });
    await n.tick();
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.text).toContain('AF-2');
    expect(ff.calls[0]!.text).toContain('needs review');
    expect(fc.kv.get('notify_cursor')).toBe('2');
  });

  it('distinguishes a transient failure from a skip-list', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    const n = new Notifier(cfg(['failed', 'skip_listed']), { core: fc.core, fetch: ff.fetch });
    await n.tick(); // init cursor (no history)

    fc.push({ type: 'comment', body: fail({ reason: 'timeout', attempt: 1, maxAttempts: 2 }) });
    fc.push({ type: 'comment', body: fail({ reason: 'max_attempts', attempt: 2, maxAttempts: 2 }) });
    await n.tick();

    expect(ff.calls).toHaveLength(2);
    expect(ff.calls[0]!.text).toContain('failed: timeout');
    expect(ff.calls[1]!.text).toContain('skip-listed');
    expect(ff.calls[1]!.text).toContain('needs you');
  });

  it('only sends events the config enables', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    const n = new Notifier(cfg(['skip_listed']), { core: fc.core, fetch: ff.fetch });
    await n.tick();

    fc.push({ type: 'status_change', toStatus: 'in_review' }); // in_review not enabled
    fc.push({ type: 'comment', body: fail({ reason: 'crashed', attempt: 1, maxAttempts: 2 }) }); // failed not enabled
    fc.push({ type: 'comment', body: fail({ reason: 'max_attempts', attempt: 2, maxAttempts: 2 }) }); // skip_listed enabled
    await n.tick();

    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.text).toContain('skip-listed');
  });

  it('ignores ordinary comments and posts to every configured webhook', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    const n = new Notifier(cfg(['failed'], ['http://a', 'http://b']), { core: fc.core, fetch: ff.fetch });
    await n.tick();
    fc.push({ type: 'comment', body: 'just a normal comment' });
    fc.push({ type: 'comment', body: fail({ reason: 'crashed' }) });
    await n.tick();
    expect(ff.calls.map((c) => c.url).sort()).toEqual(['http://a', 'http://b']); // one failure → both hooks, normal comment ignored
  });
});

describe('Notifier — state events', () => {
  it('alerts once when a supervisor goes down, and once when it recovers', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    const n = new Notifier(cfg(['supervisor_down']), { core: fc.core, fetch: ff.fetch });

    fc.setSupervisors([{ name: 'dispatcher', kind: 'dispatcher', healthy: false, staleSeconds: 120 }]);
    await n.tick();
    await n.tick(); // still down — no repeat
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.text).toContain('dispatcher');
    expect(ff.calls[0]!.text).toContain('is down');

    fc.setSupervisors([{ name: 'dispatcher', kind: 'dispatcher', healthy: true, staleSeconds: 1 }]);
    await n.tick();
    expect(ff.calls).toHaveLength(2);
    expect(ff.calls[1]!.text).toContain('recovered');
  });

  it('alerts on the queue draining to empty, on the edge only', async () => {
    const fc = makeFakeCore();
    const ff = makeFakeFetch();
    const n = new Notifier(cfg(['queue_empty']), { core: fc.core, fetch: ff.fetch });

    fc.setTasks([{ status: 'queued' }]);
    await n.tick(); // not empty
    expect(ff.calls).toHaveLength(0);
    fc.setTasks([]);
    await n.tick(); // drained → alert
    await n.tick(); // still empty → no repeat
    expect(ff.calls).toHaveLength(1);
    expect(ff.calls[0]!.text).toContain('queue is empty');
  });
});

describe('notifierConfigFromEnv', () => {
  it('returns null when no webhooks are set', () => {
    expect(notifierConfigFromEnv({})).toBeNull();
    expect(notifierConfigFromEnv({ AF_NOTIFY_WEBHOOKS: '  ,  ' })).toBeNull();
  });

  it('parses comma-separated webhooks and defaults the event set', () => {
    const c = notifierConfigFromEnv({ AF_NOTIFY_WEBHOOKS: 'http://a, http://b' })!;
    expect(c.webhooks).toEqual(['http://a', 'http://b']);
    expect([...c.events].sort()).toEqual(['in_review', 'skip_listed', 'supervisor_down']);
    expect(c.pollMs).toBe(15000);
  });

  it('honors an explicit event list and poll interval, dropping unknown events', () => {
    const c = notifierConfigFromEnv({ AF_NOTIFY_WEBHOOKS: 'http://a', AF_NOTIFY_EVENTS: 'failed, bogus, queue_empty', AF_NOTIFY_POLL_SEC: '30' })!;
    expect([...c.events].sort()).toEqual(['failed', 'queue_empty']);
    expect(c.pollMs).toBe(30000);
  });
});
