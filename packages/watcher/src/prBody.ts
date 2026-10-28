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

interface SectionTask {
  key: string;
  title: string;
  resultSummary: string | null;
  criteriaClaims?: CriterionClaim[] | null;
}

/**
 * The section content for a task: key and title, the summary's first paragraph, the AC claims —
 * at most `max` characters. The key, title and every claim entry are kept; summary prose is
 * shortened first, then claim text (evenly), then claims fall back to their ids. Null when not
 * even the key, title and claim ids fit.
 */
export function renderSection(task: SectionTask, max = MAX_SECTION): string | null {
  const header = `### ${task.key}: ${oneLine(task.title)}`;
  const claims = (task.criteriaClaims ?? []).map((c) => ({ id: c.id, text: clip(oneLine(c.claim), MAX_CLAIM) }));
  const build = (summary: string, claimText: (text: string) => string): string => {
    const lines = [header];
    if (summary) lines.push('', summary);
    if (claims.length > 0) {
      lines.push('', '**Acceptance criteria**', '');
      for (const c of claims) {
        const text = claimText(c.text);
        lines.push(text ? `- **${c.id}** — ${text}` : `- **${c.id}**`);
      }
    }
    return `\n${lines.join('\n')}\n`;
  };

  const withoutSummary = build('', (t) => t);
  if (withoutSummary.length <= max) {
    const summary = firstParagraph(task.resultSummary);
    const room = max - withoutSummary.length - 2; // the blank line before the summary
    return room >= 2 && summary ? build(clip(summary, room), (t) => t) : withoutSummary;
  }
  const idsOnly = build('', () => '');
  if (idsOnly.length > max) return null;
  // Each claim with text costs " — " (3) more than its id-only entry.
  const perClaim = Math.floor((max - idsOnly.length) / claims.length) - 3;
  return perClaim >= 2 ? build('', (t) => clip(t, perClaim)) : idsOnly;
}

/**
 * The body to send so `body`'s section is current for `task`, keeping every character outside the
 * markers: 'current' when nothing changed, 'no-room' when the section cannot fit into `maxBody`
 * without cutting human text.
 */
export function syncedBody(body: string, task: SectionTask, maxBody = Infinity): string | 'current' | 'no-room' {
  const outside = withSection(body, '').length;
  const content = renderSection(task, Math.min(MAX_SECTION, maxBody - outside));
  if (content === null) return 'no-room';
  if (sectionIsCurrent(body, content)) return 'current';
  return withSection(body, content);
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

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`;
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
