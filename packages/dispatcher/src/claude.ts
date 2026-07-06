import type { McpServerSpec } from './types.js';
import type { PermissionMode } from './config.js';

/**
 * Pick the best `claude` path from the raw output of `where`/`which`. On Windows prefer a
 * real executable (`.exe`/`.com`) over a `.cmd`/`.bat` shim: an `.exe` spawns directly with
 * `shell:false` and gets proper argument quoting, whereas a `.cmd` must be driven through
 * `cmd.exe`, which mangles args (strips embedded quotes, truncates at newlines). A bare
 * extensionless `claude` (the Git-Bash script) is not spawnable without a shell, so it ranks
 * last. Elsewhere take the first line.
 */
export function pickFromWhich(platform: NodeJS.Platform, output: string): string | null {
  const lines = output
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  if (platform === 'win32') {
    const order = ['.exe', '.com', '.cmd', '.bat'];
    for (const ext of order) {
      const hit = lines.find((l) => l.toLowerCase().endsWith(ext));
      if (hit) return hit;
    }
  }
  return lines[0] ?? null;
}

export interface ResolveClaudeOpts {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  /** Returns the first resolved path for a command, or null if unresolved. */
  lookup: (name: string) => string | null;
}

/**
 * Resolve the `claude` command. `AGENTFACTORY_CLAUDE_BIN` overrides everything; else use
 * the PATH lookup; else fall back to the platform's default shim name.
 */
export function resolveClaudeCommand({ platform, env, lookup }: ResolveClaudeOpts): string {
  const override = env['AGENTFACTORY_CLAUDE_BIN'];
  if (override && override.trim().length > 0) return override;
  const found = lookup('claude');
  if (found) return found;
  return platform === 'win32' ? 'claude.cmd' : 'claude';
}

/**
 * The headless worker prompt. One task, start to finish, then exit. It defers all
 * branch/worktree/finish mechanics to the claim's `protocol` block (computed fresh,
 * never stale) rather than baking conventions into this string.
 *
 * Authored as a SINGLE LINE with no double-quote characters: the prompt rides in argv,
 * and the `.cmd`-shim spawn path on Windows goes through `cmd.exe`, which truncates an
 * arg at the first newline and strips embedded double-quotes. Spaces and backticks are
 * preserved, so readability survives without those two characters.
 */
export function buildWorkerPrompt(): string {
  return [
    'You are an autonomous AgentFactory worker running headless. Do exactly one task, then exit.',
    'Step 1: call the agentfactory `get_next_task` tool to claim a task; if it returns `{ task: null }`',
    'the queue is empty or you lost the race, so exit immediately without doing anything else.',
    'Step 2: read the full claim payload - spec, acceptance criteria, activity log (a reclaim carries',
    'prior review feedback, so read it before working), spec images, and the `protocol` block; if the',
    'spec references a design doc under docs/superpowers/specs/, read it first. `protocol.stage` names',
    'the deliverable this claim wants: a feature description, an implementation plan, or code. If the',
    'payload carries a workspace `policy`, treat it as binding engineering standards for this task and',
    'follow it alongside the protocol.',
    'Step 3 when the stage is description: rewrite the spec into a clear feature description (keep any',
    'source-reference lines, such as an ADO work-item link, at the top) and write objectively',
    'verifiable acceptance criteria from the title, spec, activity, and images; make no repository',
    'changes at all, then call `submit_result` with summary, spec, and acceptanceCriteria.',
    'Step 3 when the stage is plan: read the workspace repository at the payload repoPath read-only and',
    'write a step-by-step implementation plan - files to change, approach, test plan - grounded in the',
    'real code; no branch, no worktree, no commits, then call `submit_result` with summary and plan.',
    'Step 3 when the stage is implementation: work only inside the task worktree that `protocol.setup`',
    'creates - never on main; follow `protocol.setup`, `protocol.branch`, and `protocol.finish`',
    'verbatim, do not improvise branch names or skip steps, and write the failing test first then',
    'implement (TDD); commits use Conventional Commits; then run the full `protocol.finish` sequence',
    'in order - it names the verify command to run from the worktree root (it MUST pass before you',
    'push), then push the feature branch, remove the worktree, and prune. Call `submit_result` with a',
    'summary covering what you built, how each acceptance criterion is met, and what you verified, a',
    'branch link, and (when the protocol named a verify command) its outcome in the `verification` field.',
    'Throughout, call the `report_progress` tool with a short status message as you start each',
    'milestone (for example: reading the spec, writing tests, running the build) so a human can follow',
    'your live progress on the board; it is ephemeral live status, not a substitute for `add_comment`.',
    'Step 4: if you are blocked or a permission is denied, record it with `add_comment`, set the task',
    '`blocked` via `update_status`, and exit - do not guess or work around denials.',
    'Claim exactly one task, do not call `get_next_task` a second time, and exit when done.',
  ].join(' ');
}

/**
 * Build the inline `--mcp-config` JSON string carrying the agentfactory MCP server, with
 * the per-session env (DB, workspace pin, worker label) that the server reads at startup.
 */
export function buildMcpConfig(spec: McpServerSpec, env: Record<string, string>): string {
  return JSON.stringify({
    mcpServers: {
      agentfactory: { command: spec.command, args: spec.args, env },
    },
  });
}

export interface SpawnArgsOpts {
  prompt: string;
  permissionMode: PermissionMode;
  /** Path to the written MCP config file — not inline JSON, which `cmd.exe` would mangle. */
  mcpConfigPath: string;
  claudeArgs: string[];
  /** A pre-generated session id (UUID). Forcing it makes the transcript path
   *  (`<config>/projects/<encoded-cwd>/<session-id>.jsonl`) deterministic at spawn, so the
   *  supervisor can tail + persist it, and disambiguates concurrent sessions sharing a cwd. */
  sessionId: string;
  /** The effective worker system prompt for this stage/workspace (resolveAgentPrompt); when
   *  non-empty it is appended to Claude's system prompt via `--append-system-prompt`. */
  appendSystemPrompt?: string | undefined;
}

/**
 * Assemble the `claude` argv: headless print mode, JSON result envelope (parsed for
 * metrics), a forced session id (pins the transcript path), the configured permission mode,
 * the MCP config file, then any extra args. The agentfactory MCP server is pre-allowed: a
 * headless session cannot answer a permission prompt, and the worker protocol requires its
 * tools for every step.
 */
export function buildSpawnArgs({ prompt, permissionMode, mcpConfigPath, claudeArgs, sessionId, appendSystemPrompt }: SpawnArgsOpts): string[] {
  return [
    '-p',
    prompt,
    '--output-format',
    'json',
    '--session-id',
    sessionId,
    '--permission-mode',
    permissionMode,
    '--mcp-config',
    mcpConfigPath,
    '--allowedTools',
    'mcp__agentfactory',
    // the configured per-stage/workspace worker system prompt, if any (single execFile arg — no shell)
    ...(appendSystemPrompt && appendSystemPrompt.trim() ? ['--append-system-prompt', appendSystemPrompt] : []),
    ...claudeArgs,
  ];
}
