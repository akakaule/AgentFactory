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

function codexBody() {
  return {
    resourceLogs: [{
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'codex.sse_event' },
          attributes: [
            { key: 'input_tokens', value: { intValue: '300' } },
            { key: 'output_tokens', value: { intValue: '40' } },
            { key: 'cached_input_tokens', value: { intValue: '10' } },
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

  it('Codex sse_event + X-Task-Key header → summed tokens', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    await postLogs(app, codexBody(), { 'x-task-key': t.key });

    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { metrics: { tokensIn: number; tokensOut: number; model: string } };
    expect(detail.metrics).toMatchObject({ tokensIn: 310, tokensOut: 40, model: 'gpt-5-codex' });
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
