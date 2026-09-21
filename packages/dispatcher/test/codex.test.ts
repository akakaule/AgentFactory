import { describe, it, expect } from 'vitest';
import { buildCodexArgs, resolveCodexCommand, parseCodexMetrics, codexFailed } from '../src/codex.js';

describe('Codex worker adapter', () => {
  it.each([undefined, []])('preserves Windows build paths without managed credentials (%j)', (shellEnvKeys) => {
    const args = buildCodexArgs({
      mcp: { command: 'node', args: [] }, mcpEnv: {},
      permissionMode: 'acceptEdits', codexArgs: [],
      ...(shellEnvKeys === undefined ? {} : { shellEnvKeys }),
    });
    expect(args).toContain('shell_environment_policy.inherit="all"');
    const include = args.find(a => a.startsWith('shell_environment_policy.include_only='));
    expect(include).toBeDefined();
    const names = JSON.parse(include!.split('=')[1]!) as string[];
    expect(names).toEqual(expect.arrayContaining([
      'ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432', 'ProgramData', 'APPDATA', 'LOCALAPPDATA',
    ]));
    expect(names).not.toContain('*');
    expect(names).not.toContain('GH_TOKEN');
    expect(names).not.toContain('AZURE_CLIENT_SECRET');
  });

  it('passes managed credential names through a core-only shell policy without putting secrets in argv', () => {
    const args = buildCodexArgs({
      mcp: { command: 'node', args: [] }, mcpEnv: {},
      permissionMode: 'acceptEdits', codexArgs: [],
      shellEnvKeys: ['GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0', 'GH_TOKEN'],
    });
    expect(args).toContain('shell_environment_policy.inherit="all"');
    const include = args.find(a => a.startsWith('shell_environment_policy.include_only='));
    expect(include).toBeDefined();
    const names = JSON.parse(include!.split('=')[1]!) as string[];
    expect(names).toEqual(expect.arrayContaining(['PATH', 'SystemRoot', 'HOME', 'APPDATA', 'GIT_CONFIG_VALUE_0', 'GH_TOKEN']));
    expect(names).not.toContain('*');
    expect(names).not.toContain('AZURE_CLIENT_SECRET');
  });

  it('encodes MCP arguments without changing backslashes or exposing secret values', () => {
    const args = buildCodexArgs({
      mcp: { command: 'C:\\Program Files\\node.exe', args: ['C:\\repo\\mcp.js'] },
      mcpEnv: { AGENTFACTORY_TOKEN: 'secret-token', AGENTFACTORY_TASK_KEY: 'AF-1' },
      permissionMode: 'acceptEdits', codexArgs: ['--model', 'gpt-5.6-luna'],
      otel: { endpoint: 'http://board:8787', taskKey: 'AF-1', token: 'secret-otel' },
    });
    expect(args).toContain('workspace-write');
    expect(args).toContain('approval_policy="never"');
    expect(args).toContain('mcp_servers.agentfactory.default_tools_approval_mode="approve"');
    expect(args).toContain('mcp_servers.agentfactory.command="C:\\\\Program Files\\\\node.exe"');
    expect(args.join(' ')).not.toContain('secret-token');
    expect(args).toContain('otel.exporter={otlp-http={endpoint="http://board:8787/v1/logs",protocol="json",headers={X-Task-Key="AF-1",Authorization="Bearer secret-otel"}}}');
    expect(args.at(-1)).toBe('-');
  });

  it('maps permission modes explicitly', () => {
    const base = { mcp: { command: 'node', args: [] }, mcpEnv: {}, codexArgs: [] };
    expect(buildCodexArgs({ ...base, permissionMode: 'plan' })).toContain('read-only');
    expect(buildCodexArgs({ ...base, permissionMode: 'default' })).toContain('read-only');
    expect(buildCodexArgs({ ...base, permissionMode: 'bypassPermissions' })).toContain('--dangerously-bypass-approvals-and-sandbox');
  });

  it('resolves a Windows npm launcher without cmd.exe and fails if it cannot', () => {
    const opts = { platform: 'win32' as const, env: {}, lookup: () => 'C:/bin/codex.cmd', fileExists: () => true };
    expect(resolveCodexCommand(opts)).toEqual({ command: process.execPath, args: [expect.stringContaining('codex.js')] });
    expect(() => resolveCodexCommand({ ...opts, fileExists: () => false })).toThrow(/launcher/);
    expect(resolveCodexCommand({ ...opts, env: { AGENTFACTORY_CODEX_BIN: 'C:/codex.exe' } })).toEqual({ command: 'C:/codex.exe', args: [] });
  });

  it('sums actual turn usage and recognizes failed turns without mistaking partial text for success', () => {
    const raw = [
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 100, cached_input_tokens: 30, output_tokens: 10 } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 50, cached_input_tokens: 20, output_tokens: 5 } }),
      '{partial',
    ].join('\n');
    expect(parseCodexMetrics(raw)).toMatchObject({ tokensIn: 150, tokensOut: 15 });
    expect(codexFailed(raw)).toBe(false);
    expect(codexFailed(JSON.stringify({ type: 'turn.failed', error: { message: 'quota' } }))).toBe(true);
    expect(codexFailed(JSON.stringify({ type: 'item.completed', item: { type: 'mcp_tool_call', status: 'failed', error: { message: 'approval required' } } }))).toBe(true);
  });
});
