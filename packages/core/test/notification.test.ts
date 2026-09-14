import { describe, expect, it } from 'vitest';
import { createCore } from '../src/index.js';
import { makeTestDb } from './helpers.js';

const NOW = '2026-09-14T18:00:00.000Z';

function makeCore() {
  const db = makeTestDb();
  return { db, core: createCore(db) };
}

describe('recoverable attention notifications', () => {
  it('captures an occurrence, per-destination outbox rows, and the source cursor atomically', () => {
    const { core, db } = makeCore();

    core.captureNotifications({
      sourceCursor: 7,
      destinations: ['http://a', 'http://b'],
      maxAttempts: 3,
      now: NOW,
      occurrences: [{
        key: 'activity:7',
        eventType: 'failed',
        reason: 'failed',
        target: 'AF-1',
        taskKey: 'AF-1',
        text: 'failure',
      }],
    });

    expect(core.getKv('notify_cursor')).toBe('7');
    expect(core.listNotificationOutbox(NOW)).toHaveLength(2);
    expect(db.prepare('SELECT COUNT(*) AS count FROM attention_occurrence').get()).toEqual({ count: 1 });
  });

  it('does not resend a successful destination when another destination fails', () => {
    const { core } = makeCore();
    core.captureNotifications({
      sourceCursor: 1,
      destinations: ['http://a', 'http://b'],
      maxAttempts: 3,
      now: NOW,
      occurrences: [{ key: 'activity:1', eventType: 'in_review', reason: 'review_ready', target: 'AF-1', text: 'review' }],
    });
    const rows = core.listNotificationOutbox(NOW);
    const first = rows.find((r) => r.destination === 'http://a')!;
    const second = rows.find((r) => r.destination === 'http://b')!;
    expect(core.settleNotificationOutbox(first.id, { ok: true, now: NOW })).toBe(true);
    expect(core.settleNotificationOutbox(second.id, { ok: false, now: NOW, error: '500', retryAt: NOW })).toBe(true);

    expect(core.listNotificationOutbox(NOW).map((r) => r.destination)).toEqual(['http://b']);
    expect(core.listNotificationOutbox(NOW)[0]!.attempts).toBe(1);
  });

  it('keeps a failed attempt eligible after reopening the board', () => {
    const first = makeCore();
    first.core.captureNotifications({
      sourceCursor: 1,
      destinations: ['http://a'],
      maxAttempts: 3,
      now: NOW,
      occurrences: [{ key: 'activity:1', eventType: 'failed', reason: 'failed', target: 'AF-1', text: 'failure' }],
    });
    const outbox = first.core.listNotificationOutbox(NOW)[0]!;
    first.core.settleNotificationOutbox(outbox.id, { ok: false, now: NOW, error: 'timeout', retryAt: NOW });

    const reopened = createCore(first.db);
    expect(reopened.listNotificationOutbox(NOW)).toHaveLength(1);
    expect(reopened.listNotificationOutbox(NOW)[0]!.attempts).toBe(1);
  });

  it('stops pending delivery when an attention occurrence is resolved', () => {
    const { core } = makeCore();
    core.captureNotifications({
      sourceCursor: 1,
      destinations: ['http://a'],
      maxAttempts: 3,
      now: NOW,
      occurrences: [{ key: 'activity:1', eventType: 'failed', reason: 'failed', target: 'AF-1', text: 'failure' }],
    });

    const occurrence = core.listAttentionOccurrences()[0]!;
    expect(core.resolveAttention(occurrence.id)).toBe(true);
    expect(core.listNotificationOutbox(NOW)).toHaveLength(0);
    expect(core.listAllNotificationOutbox()[0]!.state).toBe('pending');
  });

  it('persists supervisor edge boundaries and creates a new occurrence after resolution', () => {
    const { core } = makeCore();
    const input = {
      sourceCursor: 0,
      destinations: ['http://a'],
      maxAttempts: 3,
      now: NOW,
      occurrences: [{
        key: 'supervisor:dispatcher:down:1',
        stateKey: 'supervisor:dispatcher:down',
        eventType: 'supervisor_down' as const,
        reason: 'supervisor_unavailable' as const,
        target: 'dispatcher',
        text: 'down',
        active: true,
      }],
    };
    core.captureNotifications(input);
    core.captureNotifications({ ...input, occurrences: [{ ...input.occurrences[0], key: 'supervisor:dispatcher:down:1' }] });
    expect(core.listNotificationOutbox(NOW)).toHaveLength(1);

    core.captureNotifications({ ...input, now: '2026-09-14T18:01:00.000Z', occurrences: [{ ...input.occurrences[0], active: false }] });
    core.captureNotifications({ ...input, now: '2026-09-14T18:02:00.000Z', occurrences: [{ ...input.occurrences[0], key: 'supervisor:dispatcher:down:1', active: true }] });
    expect(core.listAllNotificationOutbox()).toHaveLength(2);
    expect(core.listNotificationOutbox('2026-09-14T18:02:00.000Z')).toHaveLength(1);
    expect(core.listAttentionOccurrences().filter((a) => a.stateKey === 'supervisor:dispatcher:down')).toHaveLength(2);
  });
});
