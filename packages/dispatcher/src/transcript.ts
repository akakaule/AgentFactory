/**
 * Where Claude Code writes a session's transcript. Given an ABSOLUTE working directory and a
 * session id, the file lives at `<config>/projects/<encoded-cwd>/<session-id>.jsonl`, where the
 * project-dir name is the absolute cwd with every separator-ish character (`/`, `\`, `:`, `.`)
 * flattened to `-` (e.g. `C:\Git\AgentFactory` → `C--Git-AgentFactory`). Pure + testable; the
 * fs lookup (and a unique-uuid fallback glob when this guess misses) lives in index.ts.
 */
export function encodeProjectDir(absCwd: string): string {
  return absCwd.replace(/[\\/:.]/g, '-');
}
