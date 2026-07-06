import { describe, it, expect } from 'vitest';
import { resolveCodexCommand, buildCodexArgs } from '../src/codex.js';

describe('resolveCodexCommand', () => {
  it('honours AGENTFACTORY_CODEX_BIN (spawned directly, no prefix)', () => {
    const c = resolveCodexCommand({ platform: 'win32', env: { AGENTFACTORY_CODEX_BIN: 'D:\\codex.exe' }, lookup: () => null, fileExists: () => false });
    expect(c).toEqual({ command: 'D:\\codex.exe', args: [] });
  });

  it('on Windows spawns node + the derived codex.js launcher (cmd.exe would strip the -c quotes)', () => {
    const c = resolveCodexCommand({ platform: 'win32', env: {}, lookup: () => 'C:\\npm\\codex.cmd', fileExists: () => true });
    expect(c.command).toBe(process.execPath);
    expect(c.args).toHaveLength(1);
    expect(c.args[0]).toContain('codex.js');
    expect(c.args[0]).toContain('@openai');
  });

  it('falls back to the .cmd shim when the derived launcher is missing', () => {
    const c = resolveCodexCommand({ platform: 'win32', env: {}, lookup: () => 'C:\\npm\\codex.cmd', fileExists: () => false });
    expect(c).toEqual({ command: 'C:\\npm\\codex.cmd', args: [] });
  });

  it('spawns the resolved codex directly on POSIX (shebang script)', () => {
    const c = resolveCodexCommand({ platform: 'linux', env: {}, lookup: () => '/usr/bin/codex', fileExists: () => false });
    expect(c).toEqual({ command: '/usr/bin/codex', args: [] });
  });

  it('defaults to the platform shim name when unresolved', () => {
    expect(resolveCodexCommand({ platform: 'linux', env: {}, lookup: () => null, fileExists: () => false })).toEqual({ command: 'codex', args: [] });
  });
});

describe('buildCodexArgs', () => {
  const base = {
    mcp: { command: 'C:\\node.exe', args: ['C:\\mcp\\index.js'] },
    mcpEnv: { AGENTFACTORY_DB: 'C:\\af.db', AGENTFACTORY_WORKSPACE: 'kl-dis', AGENTFACTORY_WORKER: 'kl-dis#AF-9-a1' },
    codexArgs: ['--dangerously-bypass-approvals-and-sandbox'],
  };

  it('injects the agentfactory MCP server via -c overrides and reads the prompt from stdin', () => {
    const a = buildCodexArgs(base);
    expect(a[0]).toBe('exec');
    expect(a).toContain('--dangerously-bypass-approvals-and-sandbox');
    expect(a[a.length - 1]).toBe('-'); // trailing `-` → prompt on stdin
    // command + args as TOML values, Windows backslashes forward-slashed so they need no escaping
    expect(a).toContain('mcp_servers.agentfactory.command="C:/node.exe"');
    expect(a).toContain('mcp_servers.agentfactory.args=["C:/mcp/index.js"]');
    // the three per-task env keys the MCP server reads at startup
    expect(a).toContain('mcp_servers.agentfactory.env.AGENTFACTORY_DB="C:/af.db"');
    expect(a).toContain('mcp_servers.agentfactory.env.AGENTFACTORY_WORKSPACE="kl-dis"');
    expect(a).toContain('mcp_servers.agentfactory.env.AGENTFACTORY_WORKER="kl-dis#AF-9-a1"');
  });

  it('has no --mcp-config (a claude-only flag) and appends codexArgs before the stdin `-`', () => {
    const a = buildCodexArgs({ ...base, codexArgs: ['-m', 'gpt-5.3-codex', '--dangerously-bypass-approvals-and-sandbox'] });
    expect(a).not.toContain('--mcp-config');
    expect(a.indexOf('-m')).toBeLessThan(a.length - 1);
    expect(a[a.length - 1]).toBe('-');
  });
});
