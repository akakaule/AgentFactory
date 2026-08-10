import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const postLogs = (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

// A Claude `claude_code.api_request` OTLP/JSON logs payload (int64 attrs encoded as strings).
function claudeBody(taskKey: string | null) {
  return {
    resourceLogs: [{
      resource: taskKey ? { attributes: [{ key: 'task.key', value: { stringValue: taskKey } }] } : {},
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'input_tokens', value: { intValue: '1000' } },
            { key: 'output_tokens', value: { intValue: '200' } },
            { key: 'cache_read_tokens', value: { intValue: '50' } },
            { key: 'cache_creation_tokens', value: { intValue: '0' } },
            { key: 'cost_usd', value: { doubleValue: 0.01 } },
            { key: 'model', value: { stringValue: 'claude-opus-4-8' } },
          ],
        }],
      }],
    }],
  };
}

// A real codex 0.14x `response.completed` sse event: the top-level `eventName` field holds
// tracing metadata (NOT the event name — it must not shadow the `event.name` attribute),
// body is null, token attrs are `*_token_count`, and int64s arrive as BOTH stringValue and
// string-encoded intValue. `input_token_count` already includes the cached prefix (OpenAI
// usage semantics).
function codexBody() {
  return {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          eventName: 'event otel\\src\\events\\session_telemetry.rs:927',
          body: null,
          attributes: [
            { key: 'event.name', value: { stringValue: 'codex.sse_event' } },
            { key: 'event.kind', value: { stringValue: 'response.completed' } },
            { key: 'input_token_count', value: { stringValue: '1200' } },
            { key: 'output_token_count', value: { stringValue: '45' } },
            { key: 'cached_token_count', value: { intValue: '300' } },
            { key: 'cache_write_token_count', value: { intValue: '0' } },
            { key: 'reasoning_token_count', value: { intValue: '0' } },
            { key: 'model', value: { stringValue: 'gpt-5-codex' } },
          ],
        }],
      }],
    }],
  };
}

describe('POST /v1/logs — OTLP token ingest', () => {
  it('Claude api_request + task.key resource attr → summed tokens (incl cache) on task_metric', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect((await postLogs(app, claudeBody(t.key))).status).toBe(200);

    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { metrics: { tokensIn: number; tokensOut: number; costUsd: number; model: string } };
    expect(detail.metrics).toMatchObject({ tokensIn: 1050, tokensOut: 200, costUsd: 0.01, model: 'claude-opus-4-8' });
  });

  it('Codex sse_event + X-Task-Key header → tokens recorded (input NOT double-counted with cached)', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    await postLogs(app, codexBody(), { 'x-task-key': t.key });

    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { metrics: { tokensIn: number; tokensOut: number; model: string } };
    expect(detail.metrics).toMatchObject({ tokensIn: 1200, tokensOut: 45, model: 'gpt-5-codex' });
  });

  it('no task.key anywhere → 200 but nothing recorded', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    expect((await postLogs(app, claudeBody(null))).status).toBe(200);
    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { metrics: { tokensIn: number | null } };
    expect(detail.metrics.tokensIn).toBeNull();
  });

  it('token mode: 401 without a token, 200 with a service token', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { auth: { mode: 'token' } });
    const token = core.createApiToken({ label: 'otel', isService: true }).token;
    expect((await postLogs(app, claudeBody('AF-1'))).status).toBe(401);
    expect((await postLogs(app, claudeBody('AF-1'), { authorization: `Bearer ${token}` })).status).toBe(200);
  });
});
