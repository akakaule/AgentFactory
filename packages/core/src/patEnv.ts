/**
 * Per-workspace credential env-var naming — the shared fallback when no PAT is stored on the
 * workspace row (migration #19). A single `AZDO_PAT` / `GITHUB_TOKEN` can't cover workspaces that
 * live in different git hosts, orgs, or projects, so each workspace can carry its own credential
 * via a naming convention on top of the base env var: `<BASE>_<WORKSPACE>`, uppercased with every
 * non-alphanumeric run collapsed to `_`. Set an env var named after the workspace and it's used;
 * omit it and the workspace falls back to the shared base var.
 *
 * e.g. base `AZDO_PAT`, workspace `kl-disconfiguration` -> `AZDO_PAT_KL_DISCONFIGURATION`.
 *
 * Lives in core (not the watcher) so the same resolution serves the worker's git auth, the
 * submit-verify, and the watcher's REST — see gitAuth.ts.
 */
export function perWorkspaceEnvVar(base: string, workspace: string): string {
  return `${base}_${workspace.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '')}`;
}

/** The base credential env var for a git provider (the shared fallback; per-workspace overrides it). */
export const BASE_ENV_VAR = { github: 'GITHUB_TOKEN', azdo: 'AZDO_PAT' } as const;
