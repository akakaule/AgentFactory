/**
 * Conventional branch name for a task: feature/<key>-<kebab-title>.
 * Must mirror the rule in the MCP tool descriptions (the agent derives the
 * same name from its claimed payload): lowercase the title, every run of
 * non-alphanumerics becomes '-', trim edge dashes, truncate to 40 chars.
 */
export function taskBranch(key: string, title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '');
  return slug ? `feature/${key}-${slug}` : `feature/${key}`;
}
