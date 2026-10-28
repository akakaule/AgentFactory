import type { CriterionClaim } from '@agentfactory/core';

/**
 * The board-managed section of a delivery PR's body. The watcher owns only the text between these
 * markers: it writes the section when it opens the PR and rewrites it on later polls when the task
 * changed. Everything outside the markers belongs to humans and is never touched.
 */
export const SECTION_BEGIN = '<!-- agentfactory:begin -->';
export const SECTION_END = '<!-- agentfactory:end -->';

/** Keeps the section well inside Azure DevOps' 4000-character description limit. */
const MAX_SECTION = 3000;
const MAX_CLAIM = 600;

/** The section content for a task: key and title, the summary's first paragraph, the AC claims. */
export function renderSection(task: {
  key: string;
  title: string;
  resultSummary: string | null;
  criteriaClaims?: CriterionClaim[] | null;
}): string {
  const lines = [`### ${task.key}: ${oneLine(task.title)}`];
  const summary = firstParagraph(task.resultSummary);
  if (summary) lines.push('', summary);
  const claims = task.criteriaClaims ?? [];
  if (claims.length > 0) {
    lines.push('', '**Acceptance criteria**', '');
    for (const c of claims) lines.push(`- **${c.id}** — ${oneLine(c.claim).slice(0, MAX_CLAIM)}`);
  }
  const text = lines.join('\n');
  return `\n${text.length > MAX_SECTION ? `${text.slice(0, MAX_SECTION - 1)}…` : text}\n`;
}

/** The text between the markers, or null when the body has no complete section. */
export function sectionOf(body: string): string | null {
  const begin = body.indexOf(SECTION_BEGIN);
  if (begin < 0) return null;
  const end = body.indexOf(SECTION_END, begin + SECTION_BEGIN.length);
  if (end < 0) return null;
  return body.slice(begin + SECTION_BEGIN.length, end);
}

/** Whether the body's section already equals `content` (line endings ignored: a web edit can
 *  return the whole body with CRLF). */
export function sectionIsCurrent(body: string, content: string): boolean {
  const current = sectionOf(body);
  return current !== null && normalize(current) === normalize(content);
}

/** `body` with its section set to `content`: replaced between the markers in place, or appended
 *  after a blank line when the body has none. */
export function withSection(body: string, content: string): string {
  const section = `${SECTION_BEGIN}${content}${SECTION_END}`;
  const begin = body.indexOf(SECTION_BEGIN);
  const end = begin < 0 ? -1 : body.indexOf(SECTION_END, begin + SECTION_BEGIN.length);
  if (begin >= 0 && end >= 0) return `${body.slice(0, begin)}${section}${body.slice(end + SECTION_END.length)}`;
  return body.length > 0 ? `${body}\n\n${section}` : section;
}

/** Fit a body into `max` characters without cutting the section: the human text before the
 *  section is shortened first; a body that still does not fit is cut plainly. */
export function fitBody(body: string, max: number): string {
  if (body.length <= max) return body;
  const begin = body.indexOf(SECTION_BEGIN);
  if (begin > 0) {
    const excess = body.length - max + 1;
    if (excess < begin) return `${body.slice(0, begin - excess)}…${body.slice(begin)}`;
  }
  return `${body.slice(0, max - 1)}…`;
}

function firstParagraph(text: string | null): string {
  return (text ?? '').trim().split(/\r?\n\s*\r?\n/)[0]?.trim() ?? '';
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n');
}
