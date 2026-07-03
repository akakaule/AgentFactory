/**
 * Per-workspace credential resolution for the delivery providers.
 *
 * A single shared `AZDO_PAT` / `GITHUB_TOKEN` can't cover workspaces that live in different git
 * hosts, orgs, or projects (an ADO PAT authenticates to one organization; least-privilege setups
 * mint one per repo). So each workspace can carry its own credential via a naming convention on
 * top of the configured base env var: `<BASE>_<WORKSPACE>`, uppercased with every non-alphanumeric
 * run collapsed to `_`. The base var stays the shared fallback. No config to maintain — set an env
 * var named after the workspace and it's used; omit it and the workspace falls back to the shared
 * one (matching the opt-out model where workspaces aren't enumerated in config).
 *
 * e.g. base `AZDO_PAT`, workspace `kl-disconfiguration` -> `AZDO_PAT_KL_DISCONFIGURATION`.
 */
export function perWorkspaceEnvVar(base: string, workspace: string): string {
  return `${base}_${workspace.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/**
 * Resolve a workspace's credential: its per-workspace override if set, else the shared base var,
 * else null (the provider then sends no auth header). Returns the resolved token plus the two env
 * var names consulted, so a failed auth can tell the operator exactly what to set.
 */
export function resolveCredential(
  env: Record<string, string | undefined>,
  base: string,
  workspace: string,
): { token: string | null; envVar: string; base: string } {
  const envVar = perWorkspaceEnvVar(base, workspace);
  return { token: env[envVar] ?? env[base] ?? null, envVar, base };
}
