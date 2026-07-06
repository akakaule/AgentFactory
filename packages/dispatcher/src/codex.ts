import { join, dirname } from 'node:path';
import type { McpServerSpec, CodexCommand } from './types.js';

export interface ResolveCodexOpts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Returns the first resolved path for a command, or null if unresolved. */
  lookup: (name: string) => string | null;
  /** True iff a file exists (used to confirm the derived codex.js launcher). */
  fileExists: (path: string) => boolean;
}

/**
 * Resolve a directly-spawnable `codex`. `AGENTFACTORY_CODEX_BIN` overrides everything. Otherwise the
 * PATH lookup — but on Windows that yields a `codex.cmd` shim, and driving it through `cmd.exe`
 * strips the embedded double-quotes from our `-c` TOML values (the MCP injection). The shim just runs
 * `node <…>/@openai/codex/bin/codex.js`, so we spawn that launcher directly (Node quotes an argv array
 * correctly). Elsewhere the resolved `codex` is a shebang script, spawnable directly.
 */
export function resolveCodexCommand({ platform, env, lookup, fileExists }: ResolveCodexOpts): CodexCommand {
  const override = env['AGENTFACTORY_CODEX_BIN'];
  if (override && override.trim().length > 0) return { command: override, args: [] };
  const found = lookup('codex');
  if (found && platform === 'win32' && /\.cmd$/i.test(found)) {
    const js = join(dirname(found), 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    if (fileExists(js)) return { command: process.execPath, args: [js] };
  }
  if (found) return { command: found, args: [] };
  return { command: platform === 'win32' ? 'codex.cmd' : 'codex', args: [] };
}

/** A TOML double-quoted string with backslashes forward-slashed (so a Windows path needs no escaping). */
const tomlStr = (s: string): string => `"${s.replace(/\\/g, '/')}"`;
const tomlArr = (arr: string[]): string => `[${arr.map(tomlStr).join(', ')}]`;

export interface CodexArgsOpts {
  /** The MCP server command+args to register (the dispatcher's `mcp` dep). */
  mcp: McpServerSpec;
  /** Per-task MCP env the server reads at startup (AGENTFACTORY_DB / WORKSPACE / WORKER). */
  mcpEnv: Record<string, string>;
  /** Configured codex flags (`config.codexArgs`) — the sandbox/approval posture + any model. */
  codexArgs: string[];
}

/**
 * Assemble the `codex exec` argv for a worker. Codex has no `--mcp-config`, so the AgentFactory MCP
 * server is injected per-task via `-c mcp_servers.agentfactory.*` overrides (a `-c` value is parsed
 * as TOML; dotted keys build the nested table). The server MUST be named `agentfactory` (the tool
 * namespace the worker prompt calls). The trailing `-` reads the worker prompt from stdin.
 */
export function buildCodexArgs({ mcp, mcpEnv, codexArgs }: CodexArgsOpts): string[] {
  const c = (kv: string): string[] => ['-c', kv];
  return [
    'exec',
    '--color', 'never',
    ...c(`mcp_servers.agentfactory.command=${tomlStr(mcp.command)}`),
    ...c(`mcp_servers.agentfactory.args=${tomlArr(mcp.args)}`),
    ...Object.entries(mcpEnv).flatMap(([k, v]) => c(`mcp_servers.agentfactory.env.${k}=${tomlStr(v)}`)),
    ...codexArgs,
    '-',
  ];
}
