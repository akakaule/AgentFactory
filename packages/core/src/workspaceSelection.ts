/**
 * Resolve which workspace slugs a supervisor (dispatcher/reviewer/watcher) serves this tick,
 * from its config plus the live DB workspace list.
 *
 * Opt-out model: an ABSENT `workspaces` list means "serve every workspace in the DB" — and
 * because callers pass the list freshly from `core.listWorkspaces()` each tick, a workspace
 * created on the board is picked up automatically, with no config edit and no restart. An
 * explicit `workspaces` list preserves the old opt-in behaviour (pin to exactly those slugs).
 * Either way, any slug in `exclude` is removed — the escape hatch for a scratch/demo workspace
 * you never want auto-served.
 *
 * @param allNames every workspace slug currently in the DB (`core.listWorkspaces().map(w => w.name)`)
 * @param opts.workspaces explicit allowlist, or undefined to serve all
 * @param opts.exclude slugs to always drop from the served set
 */
export function resolveServedWorkspaces(
  allNames: string[],
  opts: { workspaces?: string[] | undefined; exclude?: string[] | undefined } = {},
): string[] {
  const base = opts.workspaces ?? allNames;
  const excluded = new Set(opts.exclude ?? []);
  return base.filter((name) => !excluded.has(name));
}
