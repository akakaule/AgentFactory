import { z } from 'zod';
import type { AgentRole } from './types.js';

/**
 * Token-usage export for spawned agent sessions — one wiring shared by every supervisor that
 * spawns `claude`/`codex` (dispatcher workers, reviewer reviews + visualizations), so each
 * session's usage reaches the board's OTLP receiver (`web/server/routes/otel.ts`) tagged the
 * same way: task key (attribution), role (saved with the usage, so a task's cost splits per
 * activity), workspace and worker label (live Telemetry feed).
 */
export const otelConfigSchema = z
  .object({
    /** The board's base URL; the receiver lives at `<endpoint>/v1/logs`. */
    endpoint: z.string().min(1),
    /** Bearer token for a board running in token auth mode. */
    token: z.string().min(1).optional(),
  })
  .strict();

export type OtelConfig = z.infer<typeof otelConfigSchema>;

/** Who one spawned session's usage belongs to. */
export interface OtelSession {
  taskKey: string;
  workspace: string;
  /** The supervisor's session label, e.g. `ws#AF-7-a1` (worker) or `ws#AF-7-<suffix>` (review). */
  worker: string;
  /** Which kind of session this is; saved on the task_metric row. */
  role: AgentRole;
}

/** `claude` reads OTLP from its environment: the exporter env plus per-session resource attributes. */
export function claudeOtelEnv(otel: OtelConfig, s: OtelSession): Record<string, string> {
  return {
    CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    OTEL_LOGS_EXPORTER: 'otlp',
    OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_ENDPOINT: otel.endpoint,
    ...(otel.token ? { OTEL_EXPORTER_OTLP_HEADERS: `Authorization=Bearer ${otel.token}` } : {}),
    OTEL_RESOURCE_ATTRIBUTES: `task.key=${s.taskKey},af.workspace=${s.workspace},af.worker=${s.worker},af.role=${s.role}`,
  };
}

/** Escape a value as a TOML basic string (a `-c` override value is parsed as TOML). */
const tomlStr = (v: string): string => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The `codex` exporter, passed per spawn as `-c <this>`. config.toml cannot do it: codex uses the
 * configured endpoint VERBATIM (never appends `/v1/logs`) and does not interpolate env vars into
 * header values, so the session's identity rides as literal headers. No spaces or cmd.exe
 * metacharacters, so the value survives the Windows `.cmd`-shim spawn path.
 */
export function codexOtelOverride(otel: OtelConfig, s: OtelSession): string {
  const url = `${otel.endpoint.replace(/\/+$/, '')}/v1/logs`;
  const headers = [
    `X-Task-Key=${tomlStr(s.taskKey)}`,
    `X-AF-Worker=${tomlStr(s.worker)}`,
    `X-AF-Workspace=${tomlStr(s.workspace)}`,
    `X-AF-Role=${tomlStr(s.role)}`,
    ...(otel.token ? [`Authorization=${tomlStr(`Bearer ${otel.token}`)}`] : []),
  ].join(',');
  return `otel.exporter={otlp-http={endpoint=${tomlStr(url)},protocol="json",headers={${headers}}}}`;
}
