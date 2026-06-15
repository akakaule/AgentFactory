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

export interface EngineArgsOpts {
  engine: ReviewEngine;
  /** Optional model override (codex `-m`, claude `--model`). */
  model?: string | undefined;
  /** File codex captures its final message to (`--output-last-message`); ignored for claude. */
  outputFile: string;
}

/**
 * Build the engine argv. The review prompt rides on STDIN for both engines (diffs exceed
 * command-line limits), so neither carries a prompt argument.
 * - codex: `exec` read-only, no git-repo check, final message captured to a file, prompt via `-`.
 * - claude: headless single-turn text; the verdict is stdout.
 */
export function buildEngineArgs({ engine, model, outputFile }: EngineArgsOpts): string[] {
  if (engine === 'codex') {
    const args = [
      'exec', '--sandbox', 'read-only', '--skip-git-repo-check', '--color', 'never',
      '--output-last-message', outputFile,
    ];
    if (model) args.push('-m', model);
    args.push('-'); // read the prompt from stdin
    return args;
  }
  const args = ['-p', '--output-format', 'text', '--max-turns', '1'];
  if (model) args.push('--model', model);
  return args;
}
