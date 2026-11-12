import { describe, it, expect } from 'vitest';
import { otelConfigSchema, claudeOtelEnv, codexOtelOverride } from '../src/otel.js';

const session = { taskKey: 'AF-7', workspace: 'ws', worker: 'ws#AF-7-a1', role: 'worker' as const };

describe('otelConfigSchema', () => {
  it('accepts an endpoint with an optional token and rejects unknown keys', () => {
    expect(otelConfigSchema.parse({ endpoint: 'http://localhost:8787' })).toEqual({ endpoint: 'http://localhost:8787' });
    expect(otelConfigSchema.parse({ endpoint: 'http://b', token: 't' })).toEqual({ endpoint: 'http://b', token: 't' });
    expect(() => otelConfigSchema.parse({ endpoint: '' })).toThrow();
    expect(() => otelConfigSchema.parse({ endpoint: 'http://b', extra: 1 })).toThrow();
  });
});

describe('claudeOtelEnv', () => {
  it('sets the OTLP env plus task/workspace/worker resource attributes', () => {
    expect(claudeOtelEnv({ endpoint: 'http://localhost:8787', token: 'svc' }, session)).toEqual({
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
      OTEL_LOGS_EXPORTER: 'otlp',
      OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
      OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:8787',
      OTEL_EXPORTER_OTLP_HEADERS: 'Authorization=Bearer svc',
      OTEL_RESOURCE_ATTRIBUTES: 'task.key=AF-7,af.workspace=ws,af.worker=ws#AF-7-a1,af.role=worker',
    });
  });

  it('omits the auth header without a token', () => {
    expect(claudeOtelEnv({ endpoint: 'http://b' }, session)).not.toHaveProperty('OTEL_EXPORTER_OTLP_HEADERS');
  });
});

describe('codexOtelOverride', () => {
  it('appends /v1/logs and carries task, worker, workspace and auth as literal headers', () => {
    expect(codexOtelOverride({ endpoint: 'http://localhost:8787/', token: 'svc' }, session)).toBe(
      'otel.exporter={otlp-http={endpoint="http://localhost:8787/v1/logs",protocol="json",headers={X-Task-Key="AF-7",X-AF-Worker="ws#AF-7-a1",X-AF-Workspace="ws",X-AF-Role="worker",Authorization="Bearer svc"}}}',
    );
  });

  it('omits the auth header without a token and TOML-escapes values', () => {
    const v = codexOtelOverride({ endpoint: 'http://b' }, { taskKey: 'AF-7', workspace: 'a"b', worker: 'w\\x', role: 'review' });
    expect(v).toContain('X-AF-Workspace="a\\"b"');
    expect(v).toContain('X-AF-Worker="w\\\\x"');
    expect(v).not.toContain('Authorization');
  });
});
