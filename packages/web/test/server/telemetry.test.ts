import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';
import { createTelemetryStore } from '../../server/telemetry.js';
import type { TelemetryEvent } from '../../server/telemetry.js';

const postLogs = (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const getFeed = async (app: ReturnType<typeof buildApp>, headers: Record<string, string> = {}): Promise<TelemetryEvent[]> =>
  (await app.request('/api/telemetry', { headers })).json() as Promise<TelemetryEvent[]>;

function claudeBody(taskKey: string | null, extra: { workspace?: string; worker?: string } = {}) {
  const attrs: { key: string; value: { stringValue: string } }[] = [];
  if (taskKey) attrs.push({ key: 'task.key', value: { stringValue: taskKey } });
  if (extra.workspace) attrs.push({ key: 'af.workspace', value: { stringValue: extra.workspace } });
  if (extra.worker) attrs.push({ key: 'af.worker', value: { stringValue: extra.worker } });
  return {
    resourceLogs: [{
      resource: attrs.length ? { attributes: attrs } : {},
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'input_tokens', value: { intValue: '1000' } },
            { key: 'output_tokens', value: { intValue: '200' } },
            { key: 'cache_read_tokens', value: { intValue: '50' } },
            { key: 'cost_usd', value: { doubleValue: 0.01 } },
            { key: 'model', value: { stringValue: 'claude-opus-4-8' } },
          ],
        }],
      }],
    }],
  };
}

function codexBody() {
  return {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'codex.sse_event' },
          attributes: [
            { key: 'input_tokens', value: { intValue: '300' } },
            { key: 'output_tokens', value: { intValue: '40' } },
            { key: 'model', value: { stringValue: 'gpt-5-codex' } },
          ],
        }],
      }],
    }],
  };
}

describe('createTelemetryStore — ring buffer', () => {
  it('keeps events bounded, newest-first, honoring limit', () => {
    const store = createTelemetryStore(3);
    const base = { at: '2026-06-16T00:00:00.000Z', taskKey: null, workspace: null, worker: null, agent: 'codex' as const, model: null, tokensIn: 0, tokensCached: 0, tokensOut: 0, costUsd: null };
    for (let i = 1; i <= 5; i++) store.add({ ...base, tokensIn: i });

    const recent = store.recent();
    expect(recent).toHaveLength(3); // capped at 3
    expect(recent.map((e) => e.tokensIn)).toEqual([5, 4, 3]); // newest-first, oldest dropped
    expect(recent.map((e) => e.seq)).toEqual([5, 4, 3]); // seq is monotonic
    expect(store.recent(2).map((e) => e.tokensIn)).toEqual([5, 4]); // limit honored
  });
});

describe('GET /api/telemetry — live OTel feed', () => {
  it('Claude event carries workspace/worker/agent/model/tokens from the OTLP payload', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    await postLogs(app, claudeBody(t.key, { workspace: 'shopfloor', worker: 'shopfloor#AF-1-a1' }));

    const feed = await getFeed(app);
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({
      taskKey: t.key, workspace: 'shopfloor', worker: 'shopfloor#AF-1-a1',
      agent: 'claude-code', model: 'claude-opus-4-8', tokensIn: 1050, tokensCached: 50, tokensOut: 200, costUsd: 0.01,
    });
  });

  it('Codex event (via X-Task-Key) is tagged agent=codex', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    await postLogs(app, codexBody(), { 'x-task-key': t.key });

    const feed = await getFeed(app);
    expect(feed[0]).toMatchObject({ taskKey: t.key, agent: 'codex', model: 'gpt-5-codex', tokensIn: 300, tokensCached: 0, tokensOut: 40, costUsd: null });
  });

  it('returns events newest-first', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    await postLogs(app, claudeBody(t.key));
    await postLogs(app, codexBody(), { 'x-task-key': t.key });

    const feed = await getFeed(app);
    expect(feed.map((e) => e.agent)).toEqual(['codex', 'claude-code']);
  });

  it('UNATTRIBUTED events are dropped from both the live feed and the durable aggregate', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect((await postLogs(app, claudeBody(null))).status).toBe(200);

    // no task key → never enters the live feed (which now shows only task-attributed usage)
    const feed = await getFeed(app);
    expect(feed).toHaveLength(0);

    // the receiver's task_metric path is untouched — the task aggregate stays null
    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { metrics: { tokensIn: number | null } };
    expect(detail.metrics.tokensIn).toBeNull();
  });

  it('token mode: 401 without a token, 200 with a service token', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    const token = core.createApiToken({ label: 'web', isService: true }).token;

    expect((await app.request('/api/telemetry')).status).toBe(401);
    expect((await app.request('/api/telemetry', { headers: { authorization: `Bearer ${token}` } })).status).toBe(200);
  });
});
