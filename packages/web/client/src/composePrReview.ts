import type { AiReviewFinding } from './types.js';

/** `src/x.ts:42` / `src/x.ts` / null — the locator suffix for a finding. */
function locator(f: AiReviewFinding): string | null {
  if (!f.file) return null;
  return f.line != null ? `${f.file}:${f.line}` : f.file;
}

/** One markdown bullet for a finding: `- **Title** — detail (`file:line`) _severity_`. */
function findingBullet(f: AiReviewFinding): string {
  let bullet = `- **${f.title}**`;
  if (f.detail) bullet += ` — ${f.detail}`;
  const loc = locator(f);
  if (loc) bullet += ` (\`${loc}\`)`;
  if (f.severity) bullet += ` _${f.severity}_`;
  return bullet;
}

/**
 * Compose a clean, PR-ready markdown review the human copies and pastes onto the PR itself.
 * Unlike composeFeedback (which attributes each line `[reviewer-<name>]` for the implementing
 * agent), this is written for the PR author: the human's note leads, followed by a bulleted
 * list of the SELECTED findings. Unselected findings never appear. Returns '' when there is
 * nothing to say (no note, no findings) so the caller can disable the copy action.
 */
export function composePrReview(findings: AiReviewFinding[], note: string): string {
  const sections: string[] = [];
  const trimmed = note.trim();
  if (trimmed) sections.push(trimmed);
  if (findings.length > 0) sections.push(findings.map(findingBullet).join('\n'));
  return sections.join('\n\n');
}
