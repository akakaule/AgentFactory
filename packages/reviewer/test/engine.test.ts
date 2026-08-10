import { describe, it, expect } from 'vitest';
import { resolveEngineCommand, buildEngineArgs, pickFromWhich } from '../src/engine.js';

describe('resolveEngineCommand', () => {
  it('prefers the per-engine override env var', () => {
    expect(
      resolveEngineCommand('codex', { platform: 'win32', env: { AGENTFACTORY_CODEX_BIN: 'C:\\codex.exe' }, lookup: () => null }),
    ).toBe('C:\\codex.exe');
    expect(
      resolveEngineCommand('claude', { platform: 'linux', env: { AGENTFACTORY_CLAUDE_BIN: '/bin/claude' }, lookup: () => null }),
    ).toBe('/bin/claude');
  });

  it('uses the PATH lookup when there is no override', () => {
    expect(resolveEngineCommand('codex', { platform: 'linux', env: {}, lookup: (n) => `/usr/bin/${n}` })).toBe('/usr/bin/codex');
  });

  it('falls back to the platform shim name', () => {
    expect(resolveEngineCommand('codex', { platform: 'win32', env: {}, lookup: () => null })).toBe('codex.cmd');
    expect(resolveEngineCommand('claude', { platform: 'linux', env: {}, lookup: () => null })).toBe('claude');
  });
});

describe('buildEngineArgs', () => {
  it('codex: read-only exec capturing the final message, prompt via stdin (-)', () => {
    expect(buildEngineArgs({ engine: 'codex', outputFile: '/logs/x.out' })).toEqual([
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never', '--output-last-message', '/logs/x.out', '-',
    ]);
  });

  it('codex: inserts -m <model> just before the stdin marker', () => {
    const args = buildEngineArgs({ engine: 'codex', model: 'o3', outputFile: '/logs/x.out' });
    expect(args.slice(-3)).toEqual(['-m', 'o3', '-']);
  });

  it('codex: otel opts inject a full otlp-http exporter override via -c (endpoint gains /v1/logs, literal task key)', () => {
    const args = buildEngineArgs({
      engine: 'codex', outputFile: '/logs/x.out',
      otel: { endpoint: 'http://localhost:8787/', taskKey: 'AF-7', token: 'svc' },
    });
    const i = args.indexOf('-c');
    expect(i).toBeGreaterThan(-1);
    expect(args[i + 1]).toBe(
      'otel.exporter={otlp-http={endpoint="http://localhost:8787/v1/logs",protocol="json",headers={X-Task-Key="AF-7",Authorization="Bearer svc"}}}',
    );
    expect(args.at(-1)).toBe('-'); // stdin marker stays last
  });

  it('codex: otel without a token omits the Authorization header', () => {
    const args = buildEngineArgs({
      engine: 'codex', outputFile: '/logs/x.out',
      otel: { endpoint: 'http://localhost:8787', taskKey: 'AF-7' },
    });
    const override = args[args.indexOf('-c') + 1]!;
    expect(override).toContain('headers={X-Task-Key="AF-7"}');
    expect(override).not.toContain('Authorization');
  });

  it('claude: otel opts are ignored (claude reads OTLP from the environment)', () => {
    expect(
      buildEngineArgs({ engine: 'claude', outputFile: '', otel: { endpoint: 'http://x', taskKey: 'AF-7' } }),
    ).toEqual(['-p', '--output-format', 'text', '--max-turns', '1']);
  });

  it('claude: headless single-turn text (verdict on stdout)', () => {
    expect(buildEngineArgs({ engine: 'claude', outputFile: '' })).toEqual(['-p', '--output-format', 'text', '--max-turns', '1']);
  });

  it('claude: appends --model <model>', () => {
    expect(buildEngineArgs({ engine: 'claude', model: 'opus', outputFile: '' })).toEqual([
      '-p', '--output-format', 'text', '--max-turns', '1', '--model', 'opus',
    ]);
  });
});

describe('pickFromWhich', () => {
  it('prefers a real .exe over a .cmd shim on win32', () => {
    expect(pickFromWhich('win32', 'C:\\a\\codex.cmd\nC:\\b\\codex.exe')).toBe('C:\\b\\codex.exe');
  });

  it('takes the first line on non-Windows', () => {
    expect(pickFromWhich('linux', '/usr/bin/codex\n/opt/codex')).toBe('/usr/bin/codex');
  });

  it('returns null for empty output', () => {
    expect(pickFromWhich('linux', '   \n  ')).toBeNull();
  });
});
