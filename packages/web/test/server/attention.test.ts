import { describe, it, expect, beforeEach } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

// Webhook URLs usually embed a secret token; the attention API must never echo one.
const SECRET_HOOK = 'https://hooks.example.test/services/T000/B000/secret-token';
const NOW = '2026-10-22T18:00:00.000Z';

const blocked = (taskKey: string) => ({
  key: `task:${taskKey}:blocked`, stateKey: `task:${taskKey}:blocked`, eventType: 'blocked' as const,
  reason: 'blocked' as const, target: taskKey, taskKey, text: `${taskKey} is blocked`, active: true,
});

describe('attention REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
    core.captureNotifications({ sourceCursor: 0, destinations: [SECRET_HOOK], maxAttempts: 3, now: NOW, occurrences: [
      blocked('AF-1'), blocked('AF-2'),
      { key: 'supervisor:dispatcher:down', stateKey: 'supervisor:dispatcher:down', eventType: 'supervisor_down',
        reason: 'supervisor_unavailable', target: 'dispatcher', text: 'dispatcher is down', active: true },
    ] });
    // AF-2's alert is history: it stays in the table but is no longer open.
    core.captureNotifications({ sourceCursor: 0, destinations: [SECRET_HOOK], maxAttempts: 3, now: NOW,
      occurrences: [{ ...blocked('AF-2'), active: false }] });
  });

  it('never returns webhook destinations or per-destination payload text', async () => {
    const res = await app.request('/api/attention');
    expect(res.status).toBe(200);
    const raw = await res.text();
    expect(raw).not.toContain('secret-token');
    expect(raw).not.toContain('hooks.example.test');
    const body = JSON.parse(raw) as { outbox: Array<Record<string, unknown>> };
    expect(body.outbox.length).toBeGreaterThan(0);
    for (const row of body.outbox) {
      expect(row).not.toHaveProperty('destination');
      expect(row).not.toHaveProperty('text');
      expect(row).toMatchObject({ state: 'pending', attempts: 0, maxAttempts: 3 });
    }
  });

  it('returns only open attention with its delivery rows', async () => {
    const body = await (await app.request('/api/attention')).json() as {
      occurrences: Array<{ id: number; target: string; resolvedAt: string | null }>; outbox: Array<{ occurrenceId: number }>;
    };
    expect(body.occurrences.map((a) => a.target).sort()).toEqual(['AF-1', 'dispatcher']);
    expect(body.occurrences.every((a) => a.resolvedAt === null)).toBe(true);
    expect(body.outbox.map((o) => o.occurrenceId).sort()).toEqual(body.occurrences.map((a) => a.id).sort());
  });

  it('filters to one task with ?task=', async () => {
    const body = await (await app.request('/api/attention?task=AF-1')).json() as {
      occurrences: Array<{ id: number; taskKey: string | null }>; outbox: Array<{ occurrenceId: number }>;
    };
    expect(body.occurrences.map((a) => a.taskKey)).toEqual(['AF-1']);
    expect(body.outbox.map((o) => o.occurrenceId)).toEqual([body.occurrences[0]!.id]);
  });

  it('refuses service tokens but serves a signed-in human', async () => {
    const tokenApp = buildApp(core, { auth: { mode: 'token' } });
    const service = core.createApiToken({ label: 'worker', isService: true }).token;
    const denied = await tokenApp.request('/api/attention', { headers: { authorization: `Bearer ${service}` } });
    expect(denied.status).toBe(403);
    const userId = core.createUser({ email: 'human@example.com', displayName: 'Human' }).id;
    const human = core.createApiToken({ label: 'board', userId }).token;
    const allowed = await tokenApp.request('/api/attention', { headers: { authorization: `Bearer ${human}` } });
    expect(allowed.status).toBe(200);
  });
});
