import type { ReviewEngine } from './config.js';

/**
 * Pick the best CLI path from the raw output of `where`/`which`. On Windows prefer a real
 * executable (`.exe`/`.com`) over a `.cmd`/`.bat` shim: an `.exe` spawns directly with
 * correct argument quoting, whereas a `.cmd` must be driven through `cmd.exe`. Elsewhere
 * take the first line. (Mirrors the dispatcher's resolver — a sibling, not yet a shared util.)
 */
export function pickFromWhich(platform: NodeJS.Platform, output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  if (platform === 'win32') {
    for (const ext of ['.exe', '.com', '.cmd', '.bat']) {
      const hit = lines.find((l) => l.toLowerCase().endsWith(ext));
      if (hit) return hit;
    }
  }
  return lines[0] ?? null;
}

/** Per-engine override env var: set it to an absolute CLI path to bypass the PATH lookup. */
const OVERRIDE_ENV: Record<ReviewEngine, string> = {
  codex: 'AGENTFACTORY_CODEX_BIN',
  claude: 'AGENTFACTORY_CLAUDE_BIN',
};

export interface ResolveEngineOpts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Returns the first resolved path for a command, or null if unresolved. */
  lookup: (name: string) => string | null;
}

/**
 * Resolve a review engine's command. `AGENTFACTORY_{CODEX,CLAUDE}_BIN` overrides everything;
 * else use the PATH lookup; else fall back to the platform's default shim name.
 */
export function resolveEngineCommand(engine: ReviewEngine, { platform, env, lookup }: ResolveEngineOpts): string {
  const override = env[OVERRIDE_ENV[engine]];
  if (override && override.trim().length > 0) return override;
  const found = lookup(engine);
  if (found) return found;
  return platform === 'win32' ? `${engine}.cmd` : engine;
}

export interface EngineOtelOpts {
  /** The board's base URL (the OTLP path is appended here — codex uses the endpoint verbatim). */
  endpoint: string;
  /** The task this spawn's token usage is attributed to (rides as a literal header value). */
  taskKey: string;
  /** Optional bearer token for a board running in token auth mode. */
  token?: string | undefined;
}

export interface EngineArgsOpts {
  engine: ReviewEngine;
  /** Optional model override (codex `-m`, claude `--model`). */
  model?: string | undefined;
  /** File codex captures its final message to (`--output-last-message`); ignored for claude. */
  outputFile: string;
  /** When set, codex gets a `-c otel.exporter=...` override binding its token export to the
   *  task; ignored for claude (which reads OTLP from the environment). */
  otel?: EngineOtelOpts | undefined;
}

/** Escape a value as a TOML basic string (the `-c` override value is parsed as TOML). */
const tomlStr = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;

/**
 * The codex OTel exporter override, passed as `-c otel.exporter=<TOML inline table>`.
 * Injected per spawn because config.toml cannot do this: codex uses the configured endpoint
 * VERBATIM (it never appends `/v1/logs`), and it does not interpolate env vars into header
 * values — so the task key must ride as a literal, per-session header. Written without
 * spaces or cmd.exe metacharacters so the value survives the Windows `.cmd`-shim spawn path.
 */
export function buildOtelOverride({ endpoint, taskKey, token }: EngineOtelOpts): string {
  const url = `${endpoint.replace(/\/+$/, '')}/v1/logs`;
  const headers = [
    `X-Task-Key=${tomlStr(taskKey)}`,
    ...(token ? [`Authorization=${tomlStr(`Bearer ${token}`)}`] : []),
  ].join(',');
  return `otel.exporter={otlp-http={endpoint=${tomlStr(url)},protocol="json",headers={${headers}}}}`;
}

/**
 * Build the engine argv. The review prompt rides on STDIN for both engines (diffs exceed
 * command-line limits), so neither carries a prompt argument.
 * - codex: `exec` read-only, no git-repo check, final message captured to a file, prompt via `-`.
 * - claude: headless single-turn text; the verdict is stdout.
 */
export function buildEngineArgs({ engine, model, outputFile, otel }: EngineArgsOpts): string[] {
  if (engine === 'codex') {
    const args = [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never',
      '--output-last-message', outputFile,
    ];
    if (otel) args.push('-c', buildOtelOverride(otel));
    if (model) args.push('-m', model);
    args.push('-'); // read the prompt from stdin
    return args;
  }
  const args = ['-p', '--output-format', 'text', '--max-turns', '1'];
  if (model) args.push('--model', model);
  return args;
}
