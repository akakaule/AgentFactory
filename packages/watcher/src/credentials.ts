// The `<BASE>_<WORKSPACE>` naming convention now lives in core (patEnv.ts) so the same resolution
// serves the worker's git auth and the submit-verify, not just the watcher's REST. Re-exported
// here so existing importers (and tests) keep their import path.
export { perWorkspaceEnvVar } from '@agentfactory/core';
import { perWorkspaceEnvVar } from '@agentfactory/core';

/**
 * Resolve a workspace's credential: the PAT stored on the workspace (set in the board UI) if any,
 * else its per-workspace env override, else the shared base var, else null (the provider then
 * sends no auth header). Returns the resolved token plus the two env var names consulted, so a
 * failed auth can still tell the operator exactly what to set.
 */
export function resolveCredential(
  env: Record<string, string | undefined>,
  base: string,
  workspace: string,
  stored?: string | null,
): { token: string | null; envVar: string; base: string } {
  const envVar = perWorkspaceEnvVar(base, workspace);
  return { token: stored ?? env[envVar] ?? env[base] ?? null, envVar, base };
}
