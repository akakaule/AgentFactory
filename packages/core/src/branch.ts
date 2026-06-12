/**
 * Conventional feature-branch naming, computed once by the server at claim time
 * and persisted on the task. One deterministic implementation instead of N agents
 * re-deriving the rule from prose. Mirrors the client-side `taskBranch` helper
 * (packages/web/client/src/branch.ts) — keep the two in lockstep until a shared
 * package is extracted.
 */

/** Lowercase, every run of non-alphanumerics → '-', edge dashes trimmed, ≤40 chars. */
export function kebabTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
}

/** `feature/<key>-<kebab-title>`, or `feature/<key>` when the title has no usable chars. */
export function featureBranch(key: string, title: string): string {
  const slug = kebabTitle(title);
  return slug ? `feature/${key}-${slug}` : `feature/${key}`;
}
