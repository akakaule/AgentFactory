import { describe, it, expect, vi } from 'vitest';
import { Notifier, notifierConfigFromEnv, type NotifierCore, type NotifyFetch, type NotifyEvent } from '../../server/notifier.js';
import { buildFailureComment } from '@agentfactory/core';
import type { ActivityFeedRow, CaptureNotificationsInput, NotificationOutboxEntry, SupervisorView, Task } from '@agentfactory/core';

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

function makeDurableFakeCore() {
  const fc = makeFakeCore();
  const occurrences = new Map<string, { id: number; stateKey?: string; resolved: boolean; text: string }>();
  const outbox: NotificationOutboxEntry[] = [];
  let nextOccurrenceId = 1;
  let nextOutboxId = 1;
  const core: NotifierCore = {
    ...fc.core,
    captureNotifications: (input: CaptureNotificationsInput) => {
      fc.kv.set('notify_cursor', String(input.sourceCursor));
      for (const item of input.occurrences) {
        const existing = [...occurrences.values()].find((o) =>
          !o.resolved && (o.stateKey === item.stateKey || o.stateKey === undefined && item.stateKey === undefined && o.text === item.text));
        if (item.active === false) {
          for (const occurrence of occurrences.values()) if (occurrence.stateKey === item.stateKey) occurrence.resolved = true;
          continue;
        }
        const occurrence = existing ?? (() => {
          const created = { id: nextOccurrenceId++, ...(item.stateKey ? { stateKey: item.stateKey } : {}), resolved: false, text: item.text };
          occurrences.set(`${item.key}:${created.id}`, created);
          return created;
        })();
        for (const destination of input.destinations) {
          if (outbox.some((row) => row.occurrenceId === occurrence.id && row.destination === destination)) continue;
          outbox.push({
            id: nextOutboxId++, occurrenceId: occurrence.id, destination, text: item.text, state: 'pending',
            attempts: 0, maxAttempts: input.maxAttempts, nextAttemptAt: input.now ?? '2026-09-14T18:00:00.000Z',
            lastError: null, sentAt: null, createdAt: input.now ?? '2026-09-14T18:00:00.000Z',
            updatedAt: input.now ?? '2026-09-14T18:00:00.000Z', eventType: item.eventType, reason: item.reason,
            target: item.target, taskKey: item.taskKey ?? null,
          });
        }
      }
    },
    listNotificationOutbox: (now = '9999-12-31T00:00:00.000Z', limit = 100) => outbox
      .filter((row) => (row.state === 'pending' || row.state === 'failed') && row.nextAttemptAt <= now)
      .slice(0, limit),
    settleNotificationOutbox: (id, input) => {
      const row = outbox.find((candidate) => candidate.id === id);
      if (!row || row.state === 'succeeded' || row.state === 'permanently_failed') return false;
      row.attempts += 1;
      row.updatedAt = input.now ?? row.updatedAt;
      if (input.ok) {
        row.state = 'succeeded'; row.sentAt = input.now ?? row.updatedAt; row.lastError = null;
      } else {
        row.state = row.attempts >= row.maxAttempts ? 'permanently_failed' : 'failed';
        row.nextAttemptAt = input.retryAt ?? row.updatedAt; row.lastError = input.error ?? 'failed';
      }
      return true;
    },
  };
  return { ...fc, core, outbox };
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

describe('Notifier — durable delivery', () => {
  it('recovers a receiver that fails twice across notifier restarts', async () => {
    const fc = makeDurableFakeCore();
    const calls: string[] = [];
    const fetch: NotifyFetch = async (url) => {
      calls.push(url);
      return calls.length < 3 ? { ok: false, status: 500 } : { ok: true, status: 200 };
    };
    const config = { ...cfg(['failed']), retryBaseMs: 0, retryMaxMs: 0, maxAttempts: 3 };
    await new Notifier(config, { core: fc.core, fetch }).tick();
    fc.push({ type: 'comment', body: fail({ reason: 'timeout' }) });
    await new Notifier(config, { core: fc.core, fetch }).tick();
    await new Notifier(config, { core: fc.core, fetch }).tick();
    await new Notifier(config, { core: fc.core, fetch }).tick();

    expect(calls).toEqual(['http://hook', 'http://hook', 'http://hook']);
    expect(fc.outbox[0]!.state).toBe('succeeded');
    expect(fc.outbox[0]!.attempts).toBe(3);
  });

  it('does not resend a destination that succeeded when another destination failed', async () => {
    const fc = makeDurableFakeCore();
    const calls: string[] = [];
    const fetch: NotifyFetch = async (url) => {
      calls.push(url);
      return url === 'http://bad' ? { ok: false, status: 500 } : { ok: true, status: 200 };
    };
    const config = { ...cfg(['failed'], ['http://good', 'http://bad']), retryBaseMs: 0, retryMaxMs: 0 };
    await new Notifier(config, { core: fc.core, fetch }).tick();
    fc.push({ type: 'comment', body: fail() });
    await new Notifier(config, { core: fc.core, fetch }).tick();
    await new Notifier(config, { core: fc.core, fetch }).tick();

    expect(calls).toEqual(['http://good', 'http://bad', 'http://bad']);
  });

  it('records a network timeout as a retryable outbox failure', async () => {
    const fc = makeDurableFakeCore();
    const warnings: string[] = [];
    const fetch: NotifyFetch = async () => new Promise(() => undefined);
    const config = { ...cfg(['failed']), timeoutMs: 1, retryBaseMs: 0, retryMaxMs: 0 };
    const n = new Notifier(config, {
      core: fc.core, fetch,
      console: { log: () => undefined, error: () => undefined, warn: (message) => warnings.push(message) },
    });
    await n.tick();
    fc.push({ type: 'comment', body: fail() });
    await n.tick();

    expect(fc.outbox[0]!.state).toBe('failed');
    expect(fc.outbox[0]!.lastError).toContain('timed out');
    expect(warnings[0]).toContain('retry at');
  });

  it('serializes overlapping poll ticks', async () => {
    const fc = makeDurableFakeCore();
    let release!: () => void;
    let calls = 0;
    const fetch: NotifyFetch = async () => {
      calls += 1;
      await new Promise<void>((resolve) => { release = resolve; });
      return { ok: true, status: 200 };
    };
    const n = new Notifier({ ...cfg(['failed']), retryBaseMs: 0 }, { core: fc.core, fetch });
    await n.tick();
    fc.push({ type: 'comment', body: fail() });
    const first = n.tick();
    const second = n.tick();
    await vi.waitFor(() => expect(calls).toBe(1));
    expect(calls).toBe(1);
    release();
    await Promise.all([first, second]);
    expect(fc.outbox[0]!.state).toBe('succeeded');
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
