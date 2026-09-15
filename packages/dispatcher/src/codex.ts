import { dirname, join } from 'node:path';
import type { PermissionMode } from './config.js';
import type { McpServerSpec } from './types.js';
import type { ParsedMetrics } from './metrics.js';

export interface CodexCommand { command: string; args: string[]; }

/** Never pass TOML overrides through cmd.exe: its quoting corrupts embedded strings. */
export function resolveCodexCommand(opts: {
  platform: NodeJS.Platform; env: NodeJS.ProcessEnv;
  lookup: (name: string) => string | null; fileExists: (path: string) => boolean;
}): CodexCommand {
  const found = opts.env['AGENTFACTORY_CODEX_BIN']?.trim() || opts.lookup('codex');
  if (!found) throw new Error('Codex CLI not found; install it or set AGENTFACTORY_CODEX_BIN');
  if (opts.platform === 'win32' && /\.(cmd|bat)$/i.test(found)) {
    const launcher = join(dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (!opts.fileExists(launcher)) throw new Error(`Cannot resolve a direct Codex launcher for ${found}; set AGENTFACTORY_CODEX_BIN to codex.exe`);
    return { command: process.execPath, args: [launcher] };
  }
  return { command: found, args: [] };
}

// JSON string escapes are valid for the control characters used here in TOML basic strings.
const str = (value: string): string => JSON.stringify(value);
const arr = (values: string[]): string => `[${values.map(str).join(',')}]`;

// Preserve normal shell/tool discovery alongside explicitly managed credentials. An
// inherited `inherit="core"` drops Windows build paths as well as managed credentials.
// Apply this baseline even when the workspace has no managed Git credentials.
const CORE_SHELL_ENV = [
  'PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'USERDOMAIN', 'USERNAME', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA',
  'LOCALAPPDATA', 'ProgramData', 'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432',
  'HOME', 'USER', 'LOGNAME', 'SHELL', 'PWD', 'LANG', 'LC_*', 'TERM',
];

export function buildCodexArgs(opts: {
  mcp: McpServerSpec; mcpEnv: Record<string, string>; permissionMode: PermissionMode;
  codexArgs: string[]; otel?: { endpoint: string; taskKey: string; token?: string | undefined } | undefined;
  shellEnvKeys?: string[];
}): string[] {
  const config = (value: string): string[] => ['-c', value];
  return [
    'exec', '--json', '--color', 'never',
    ...(opts.permissionMode === 'bypassPermissions'
      ? ['--dangerously-bypass-approvals-and-sandbox']
      : ['--sandbox', opts.permissionMode === 'acceptEdits' ? 'workspace-write' : 'read-only', ...config('approval_policy="never"')]),
    ...(opts.permissionMode === 'acceptEdits' ? config('sandbox_workspace_write.network_access=true') : []),
    ...config('shell_environment_policy.inherit="all"'),
    ...config(`shell_environment_policy.include_only=${arr([...CORE_SHELL_ENV, ...(opts.shellEnvKeys ?? [])])}`),
    ...config(`mcp_servers.agentfactory.command=${str(opts.mcp.command)}`),
    ...config(`mcp_servers.agentfactory.args=${arr(opts.mcp.args)}`),
    // MCP secrets stay in the process environment, not argv. Nonsecret overrides
    // prevent an inherited DB or board URL from selecting the wrong backend.
    ...config(`mcp_servers.agentfactory.env_vars=${arr(Object.keys(opts.mcpEnv))}`),
    ...config(`mcp_servers.agentfactory.env={${Object.entries(opts.mcpEnv).filter(([key]) => !/TOKEN|SECRET|PASSWORD/i.test(key)).map(([key, value]) =>
      `${key}=${str(value)}`).join(',')}}`),
    ...config('mcp_servers.agentfactory.required=true'),
    // Equivalent to Claude's --allowedTools mcp__agentfactory: these board tools
    // are the explicitly authorized worker protocol, not arbitrary external MCP.
    ...config('mcp_servers.agentfactory.default_tools_approval_mode="approve"'),
    ...(opts.otel ? config(`otel.exporter={otlp-http={endpoint=${str(`${opts.otel.endpoint.replace(/\/+$/, '')}/v1/logs`)},protocol="json",headers={X-Task-Key=${str(opts.otel.taskKey)}${opts.otel.token ? `,Authorization=${str(`Bearer ${opts.otel.token}`)}` : ''}}}}`) : []),
    ...opts.codexArgs, '-',
  ];
}

function events(raw: string): Record<string, unknown>[] {
  return raw.split('\n').flatMap(line => {
    try { const e: unknown = JSON.parse(line); return e && typeof e === 'object' ? [e as Record<string, unknown>] : []; }
    catch { return []; }
  });
}

export function codexFailed(raw: string): boolean {
  return events(raw).some(e => {
    if (e['type'] === 'turn.failed' || e['type'] === 'error') return true;
    const item = e['item'];
    return e['type'] === 'item.completed' && item != null && typeof item === 'object' &&
      (item as Record<string, unknown>)['type'] === 'mcp_tool_call' &&
      (item as Record<string, unknown>)['status'] === 'failed';
  });
}

export function parseCodexMetrics(raw: string): ParsedMetrics {
  const result: ParsedMetrics = {};
  for (const event of events(raw)) {
    if (event['type'] !== 'turn.completed' || !event['usage'] || typeof event['usage'] !== 'object') continue;
    const usage = event['usage'] as Record<string, unknown>;
    // Codex input_tokens already includes cached_input_tokens.
    for (const [source, target] of [['input_tokens', 'tokensIn'], ['output_tokens', 'tokensOut']] as const) {
      const value = usage[source];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) result[target] = (result[target] ?? 0) + value;
    }
  }
  return result;
}
