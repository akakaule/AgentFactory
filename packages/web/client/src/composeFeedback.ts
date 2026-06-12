import type { AiReviewFinding } from './types.js';

/** `src/x.ts:42` / `src/x.ts` / null — the locator suffix for a finding line. */
function locator(f: AiReviewFinding): string | null {
  if (!f.file) return null;
  return f.line != null ? `${f.file}:${f.line}` : f.file;
}

/** One attributed line for a reviewer finding: `[reviewer-codex] Title — detail (file:line)`. */
function findingLine(f: AiReviewFinding, who: string): string {
  let line = `[${who}] ${f.title}`;
  if (f.detail) line += ` — ${f.detail}`;
  const loc = locator(f);
  if (loc) line += ` (${loc})`;
  return line;
}

/**
 * Compose the curated request-changes body the human sends back: the SELECTED reviewer
 * findings (each attributed `[reviewer-<name>]`) followed by the human's own note. The
 * human note is attributed `[human]` only when reviewer findings exist to disambiguate
 * the sources; with no AI review it stays a plain note (the round-1 behaviour). Unselected
 * findings never appear. Returns '' when nothing is selected and no note is written.
 */
export function composeFeedback(
  selected: AiReviewFinding[],
  reviewer: string | null,
  humanNote: string,
  reviewPresent: boolean,
): string {
  const who = reviewer ? `reviewer-${reviewer}` : 'reviewer';
  const lines = selected.map((f) => findingLine(f, who));
  const note = humanNote.trim();
  if (note) lines.push(reviewPresent ? `[human] ${note}` : note);
  return lines.join('\n\n');
}
