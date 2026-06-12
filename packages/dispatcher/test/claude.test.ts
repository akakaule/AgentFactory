import { describe, it, expect } from 'vitest';
import {
  pickFromWhich,
  resolveClaudeCommand,
  buildWorkerPrompt,
  buildMcpConfig,
  buildSpawnArgs,
} from '../src/claude.js';

describe('pickFromWhich', () => {
  it('prefers the .exe over the .cmd shim on win32 (clean shell:false spawn)', () => {
    const out = ['C:\\Users\\x\\AppData\\npm\\claude.cmd', 'C:\\Users\\x\\.local\\bin\\claude.exe'].join('\r\n');
    expect(pickFromWhich('win32', out)).toBe('C:\\Users\\x\\.local\\bin\\claude.exe');
  });

  it('falls back to .cmd then the first line on win32', () => {
    expect(pickFromWhich('win32', 'C:\\a\\claude.cmd')).toBe('C:\\a\\claude.cmd');
    expect(pickFromWhich('win32', 'C:\\a\\claude')).toBe('C:\\a\\claude');
  });

  it('takes the first line on posix', () => {
    expect(pickFromWhich('linux', '/usr/local/bin/claude\n/opt/bin/claude')).toBe('/usr/local/bin/claude');
  });

  it('returns null on empty output', () => {
    expect(pickFromWhich('win32', '   \n  ')).toBeNull();
  });
});

describe('resolveClaudeCommand', () => {
  it('honours AGENTFACTORY_CLAUDE_BIN override', () => {
    const cmd = resolveClaudeCommand({ platform: 'win32', env: { AGENTFACTORY_CLAUDE_BIN: 'D:\\claude.cmd' }, lookup: () => null });
    expect(cmd).toBe('D:\\claude.cmd');
  });

  it('uses the PATH lookup when present', () => {
    const cmd = resolveClaudeCommand({ platform: 'win32', env: {}, lookup: () => 'C:\\bin\\claude.cmd' });
    expect(cmd).toBe('C:\\bin\\claude.cmd');
  });

  it('falls back to claude.cmd on win32 when unresolved', () => {
    expect(resolveClaudeCommand({ platform: 'win32', env: {}, lookup: () => null })).toBe('claude.cmd');
  });

  it('falls back to claude on posix when unresolved', () => {
    expect(resolveClaudeCommand({ platform: 'linux', env: {}, lookup: () => null })).toBe('claude');
  });
});

describe('buildWorkerPrompt', () => {
  it('tells the session to claim one task, follow the protocol, submit, then exit', () => {
    const p = buildWorkerPrompt();
    expect(p).toContain('get_next_task');
    expect(p).toContain('task: null');
    expect(p).toContain('protocol');
    expect(p).toContain('submit_result');
    expect(p.toLowerCase()).toContain('exit');
  });

  it('carries per-stage instructions keyed off protocol.stage', () => {
    const p = buildWorkerPrompt();
    expect(p).toContain('protocol.stage');
    expect(p).toContain('stage is description');
    expect(p).toContain('stage is plan');
    expect(p).toContain('stage is implementation');
    expect(p).toContain('acceptanceCriteria');
  });
});

describe('buildMcpConfig', () => {
  it('wraps the agentfactory server with command, args, and the per-session env', () => {
    const json = buildMcpConfig({ command: 'node', args: ['/mcp/index.js'] }, {
      AGENTFACTORY_DB: './af.db',
      AGENTFACTORY_WORKSPACE: 'ws',
      AGENTFACTORY_WORKER: 'ws#AF-1-a1',
    });
    const parsed = JSON.parse(json);
    expect(parsed.mcpServers.agentfactory.command).toBe('node');
    expect(parsed.mcpServers.agentfactory.args).toEqual(['/mcp/index.js']);
    expect(parsed.mcpServers.agentfactory.env.AGENTFACTORY_WORKER).toBe('ws#AF-1-a1');
  });
});

describe('buildSpawnArgs', () => {
  it('builds headless print mode with json output, permission mode, and the mcp config file path', () => {
    const args = buildSpawnArgs({
      prompt: 'PROMPT',
      permissionMode: 'acceptEdits',
      mcpConfigPath: '/logs/AF-1-attempt-1.mcp.json',
      claudeArgs: ['--extra'],
    });
    expect(args).toContain('-p');
    expect(args).toContain('PROMPT');
    expect(args.join(' ')).toContain('--output-format json');
    expect(args.join(' ')).toContain('--permission-mode acceptEdits');
    expect(args[args.indexOf('--mcp-config') + 1]).toBe('/logs/AF-1-attempt-1.mcp.json');
    // extra args land at the end
    expect(args[args.length - 1]).toBe('--extra');
  });

  it('keeps the prompt a single quote-free line (survives the Windows cmd.exe spawn path)', () => {
    const p = buildWorkerPrompt();
    expect(p).not.toContain('\n');
    expect(p).not.toContain('"');
  });
});
