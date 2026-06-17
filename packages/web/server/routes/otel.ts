import { Hono } from 'hono';
import type { Core } from '../types.js';
import type { TelemetryStore } from '../telemetry.js';

/**
 * OTLP/HTTP **logs** receiver (JSON only) at POST /v1/logs. Both Claude Code and Codex
 * export token usage as log events over standard OTLP — this reads the token-bearing
 * events and writes them into `task_metric` (via core.addTaskMetrics), so token usage is
 * captured in BOTH interactive and headless runs. Tolerant by design: malformed or
 * unattributed events are skipped, never failing the batch (the CLI would otherwise retry).
 *
 * Correlation to a task (first match wins): the `X-Task-Key` request header (Codex stamps
 * it via a config header), then a `task.key` resource attribute (Claude stamps it via
 * OTEL_RESOURCE_ATTRIBUTES), then a `task.key` log attribute. No key → the event is dropped.
 */

// Minimal slice of the OTLP/JSON logs shape (only the fields we read).
interface AnyValue { stringValue?: string; intValue?: string | number; doubleValue?: number }
interface KeyValue { key: string; value?: AnyValue }
interface LogRecord { eventName?: string; body?: AnyValue; attributes?: KeyValue[] }
interface ResourceLogs { resource?: { attributes?: KeyValue[] }; scopeLogs?: { logRecords?: LogRecord[] }[] }
interface OtlpLogs { resourceLogs?: ResourceLogs[] }

const attrOf = (attrs: KeyValue[] | undefined, key: string): AnyValue | undefined =>
  attrs?.find((a) => a.key === key)?.value;

const asStr = (v?: AnyValue): string | undefined =>
  v?.stringValue ?? (v?.intValue !== undefined ? String(v.intValue) : undefined);

// OTLP/JSON encodes int64 as a STRING ({"intValue":"1234"}); also tolerate number/double.
const asNum = (v?: AnyValue): number | undefined => {
  if (!v) return undefined;
  if (typeof v.intValue === 'number') return v.intValue;
  if (typeof v.intValue === 'string' && v.intValue.trim() !== '') return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.stringValue !== undefined && v.stringValue.trim() !== '' && !Number.isNaN(Number(v.stringValue))) return Number(v.stringValue);
  return undefined;
};

const eventNameOf = (rec: LogRecord): string =>
  rec.eventName ?? asStr(rec.body) ?? asStr(attrOf(rec.attributes, 'event.name')) ?? '';

interface TokenHit { tokensIn: number; tokensCached: number; tokensOut: number; costUsd?: number; model?: string; source: 'claude-code' | 'codex' }

/** Pull a token record from a single log event, or null if it carries no usage. */
function extract(rec: LogRecord): TokenHit | null {
  const a = rec.attributes;
  const name = eventNameOf(rec);

  if (name === 'claude_code.api_request') {
    const input = asNum(attrOf(a, 'input_tokens')) ?? 0;
    const output = asNum(attrOf(a, 'output_tokens')) ?? 0;
    const cacheRead = asNum(attrOf(a, 'cache_read_tokens')) ?? 0;
    const cacheCreate = asNum(attrOf(a, 'cache_creation_tokens')) ?? 0;
    if (input + output + cacheRead + cacheCreate === 0) return null;
    const hit: TokenHit = { tokensIn: input + cacheRead + cacheCreate, tokensCached: cacheRead + cacheCreate, tokensOut: output, source: 'claude-code' };
    const cost = asNum(attrOf(a, 'cost_usd')); if (cost !== undefined) hit.costUsd = cost;
    const model = asStr(attrOf(a, 'model')); if (model !== undefined) hit.model = model;
    return hit;
  }

  if (name === 'codex.sse_event' || name === 'response.completed') {
    const input = asNum(attrOf(a, 'input_tokens')) ?? asNum(attrOf(a, 'input')) ?? 0;
    const output = asNum(attrOf(a, 'output_tokens')) ?? asNum(attrOf(a, 'output')) ?? 0;
    const cached = asNum(attrOf(a, 'cached_input_tokens')) ?? asNum(attrOf(a, 'cached')) ?? 0;
    if (input + output + cached === 0) return null;
    const hit: TokenHit = { tokensIn: input + cached, tokensCached: cached, tokensOut: output, source: 'codex' };
    const model = asStr(attrOf(a, 'model')); if (model !== undefined) hit.model = model;
    return hit;
  }

  return null;
}

export function otelRoutes(core: Core, telemetry?: TelemetryStore): Hono {
  const r = new Hono();

  r.post('/logs', async (c) => {
    const headerKey = c.req.header('x-task-key')?.trim() || undefined;
    let payload: OtlpLogs;
    try { payload = (await c.req.json()) as OtlpLogs; } catch { return c.json({}, 200); }

    for (const rl of payload.resourceLogs ?? []) {
      // Resource attributes the dispatcher stamps once per session (otel block in its config).
      const resourceKey = asStr(attrOf(rl.resource?.attributes, 'task.key'));
      const workspace = asStr(attrOf(rl.resource?.attributes, 'af.workspace')) ?? null;
      const worker = asStr(attrOf(rl.resource?.attributes, 'af.worker')) ?? null;
      for (const sl of rl.scopeLogs ?? []) {
        for (const rec of sl.logRecords ?? []) {
          const hit = extract(rec);
          if (!hit) continue;
          const key = headerKey ?? resourceKey ?? asStr(attrOf(rec.attributes, 'task.key'));
          if (!key) continue; // unattributed — drop from both the live feed and the durable aggregate

          // Live feed: every task-attributed event, for "what's flowing right now" visibility.
          telemetry?.add({
            at: new Date().toISOString(),
            taskKey: key,
            workspace,
            worker,
            agent: hit.source,
            model: hit.model ?? null,
            tokensIn: hit.tokensIn,
            tokensCached: hit.tokensCached,
            tokensOut: hit.tokensOut,
            costUsd: hit.costUsd ?? null,
          });

          const input: { model?: string; tokensIn: number; tokensOut: number; costUsd?: number; reportedBy: string } = {
            tokensIn: hit.tokensIn, tokensOut: hit.tokensOut, reportedBy: `otel:${hit.source}`,
          };
          if (hit.model !== undefined) input.model = hit.model;
          if (hit.costUsd !== undefined) input.costUsd = hit.costUsd;
          try { core.addTaskMetrics(key, input); } catch { /* unknown task / invalid — skip this event */ }
        }
      }
    }
    return c.json({}, 200); // OTLP success (ExportLogsServiceResponse)
  });

  return r;
}
