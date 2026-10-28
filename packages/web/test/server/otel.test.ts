import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const postLogs = (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/v1/logs', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

const costOf = async (app: ReturnType<typeof buildApp>, key: string) =>
  ((await (await app.request(`/api/tasks/${key}`)).json()) as { metrics: { costUsd: number | null } }).metrics.costUsd;

// A Claude `claude_code.api_request` OTLP/JSON logs payload (int64 attrs encoded as strings).
// Claude Code 2.x carries the prefixed name in `body` only; its `event.name` attribute is the
// UNPREFIXED `api_request` — which must not shadow the body the way codex's `eventName` may not.
function claudeBody(taskKey: string | null) {
  return {
    resourceLogs: [{
      resource: taskKey ? { attributes: [{ key: 'task.key', value: { stringValue: taskKey } }] } : {},
      scopeLogs: [{
        logRecords: [{
          body: { stringValue: 'claude_code.api_request' },
          attributes: [
            { key: 'event.name', value: { stringValue: 'api_request' } },
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
  it('retains the Codex discussion phase and workspace from supervisor headers', async () => {
    const core = openCore(':memory:'); const app = buildApp(core);
    const t = core.createTask({ title: 'Review', spec: 'S', acceptanceCriteria: 'A' });
    await postLogs(app, codexBody(), { 'x-task-key': t.key, 'x-af-worker': 'ws#AF-1-r1-2-codex-cross-examination', 'x-af-workspace': 'ws' });
    const payload = await (await app.request('/api/telemetry')).json() as Array<{ worker: string; workspace: string }>;
    expect(payload[0]).toMatchObject({ worker: 'ws#AF-1-r1-2-codex-cross-examination', workspace: 'ws' });
  });
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

  it('Codex reports no cost: unpriced model → null, priced model → cost from the board price table', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    const unpriced = core.createTask({ title: 'U', spec: 'S', acceptanceCriteria: 'A' });
    await postLogs(app, codexBody(), { 'x-task-key': unpriced.key });
    expect((await costOf(app, unpriced.key))).toBeNull();

    core.setModelPrices({ 'gpt-5-codex': { input: 2, cachedInput: 0.2, output: 10 } });
    const priced = core.createTask({ title: 'P', spec: 'S', acceptanceCriteria: 'A' });
    await postLogs(app, codexBody(), { 'x-task-key': priced.key });
    // 900 uncached·$2 + 300 cached·$0.20 + 45 out·$10, per 1M tokens
    expect((await costOf(app, priced.key))).toBeCloseTo(0.00231, 10);
    const feed = await (await app.request('/api/telemetry')).json() as Array<{ taskKey: string; costUsd: number | null }>;
    expect(feed.find((e) => e.taskKey === priced.key)?.costUsd).toBeCloseTo(0.00231, 10);
    expect(feed.find((e) => e.taskKey === unpriced.key)?.costUsd).toBeNull();
  });

  it('a priced Claude model keeps the cost Claude reported', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core);
    core.setModelPrices({ 'claude-opus-4-8': { input: 100, cachedInput: 100, output: 100 } });
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    await postLogs(app, claudeBody(t.key));
    expect((await costOf(app, t.key))).toBe(0.01);
  });

  it('records tokens for a task whose dispatched worker holds a live execution', async () => {
    // autoFence:false = the production board: the worker's claim came from its own MCP server
    // (claimedBy label → an owned execution), never from this process
    const core = openCore(':memory:', { autoFence: false });
    const app = buildApp(core);
    const t = core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    core.updateStatus(t.key, 'queued', 'human');
    core.claimNextTask({ claimedBy: `default#${t.key}-a1` });

    expect((await postLogs(app, claudeBody(t.key))).status).toBe(200);

    const detail = await (await app.request(`/api/tasks/${t.key}`)).json() as { status: string; metrics: { tokensIn: number | null } };
    expect(detail.status).toBe('in_progress');
    expect(detail.metrics.tokensIn).toBe(1050);
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
