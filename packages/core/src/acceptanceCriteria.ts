/**
 * Acceptance criteria as numbered items — the one parser the reviewer prompt, the worker protocol
 * and the board UI all take criterion ids from, so an id can never drift between them
 * (docs/spec/2026-10-21-review-decision-panel-design.md §4.1). Ids are positional (AC1…ACn in
 * order of appearance), whatever numbers the author typed.
 */
/** What a task created at the spec stage carries until that stage writes real criteria. A task whose
 *  spec stage was skipped still has it at implementation, where the worker submits the criteria. */
export const PLACEHOLDER_ACCEPTANCE_CRITERIA = 'To be defined by the description stage.';

export interface AcceptanceCriterion { id: string; name: string | null; text: string }
export interface ParsedCriteria { items: AcceptanceCriterion[]; general: string | null }

// a numbered (`1.` / `1)`), bulleted (`-` `*` `•`, optionally `- [ ]` / `- [x]`) or labelled
// (`AC1 —`, `AC2:`, `AC 3.`) list line
const LIST_LINE = /^([ \t]*)(?:\d+[.)]|[-*•]|AC ?\d+(?:[ \t]*[—–:.)-])?)[ \t]+(?:\[[ xX]\][ \t]+)?(.*)$/;
// the name is the short prefix before the first separator: "Race — two supervisors …"
const NAME_SEPARATOR = / [—–-] |: /;
const NAME_MAX = 48;

const indentOf = (line: string) => line.length - line.trimStart().length;

function nameOf(text: string): string | null {
  const firstLine = text.split('\n', 1)[0]!;
  const sep = NAME_SEPARATOR.exec(firstLine);
  if (!sep) return null;
  const name = firstLine.slice(0, sep.index).trim();
  return name.length >= 1 && name.length <= NAME_MAX ? name : null;
}

export function parseAcceptanceCriteria(text: string): ParsedCriteria {
  const items: string[][] = [];
  const paragraphs: string[][] = [];
  let itemIndent: number | null = null; // the first item's indent: list lines no deeper start items
  let item: string[] | null = null;     // the open item's lines
  let paragraph: string[] | null = null; // the open general paragraph's lines
  let blank = false;                     // a blank line since the last content line

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim() === '') { blank = true; continue; }
    const indent = indentOf(line);
    const list = LIST_LINE.exec(line);
    if (list && (itemIndent === null || indent <= itemIndent)) {
      itemIndent ??= indent;
      item = [list[2]!.trim()];
      items.push(item);
      paragraph = null;
    } else if (item && (!blank || indent > itemIndent!)) {
      // nested bullets and continuation lines belong to the open item, relative indent kept
      if (blank) item.push('');
      item.push(line.slice(Math.min(indent, itemIndent!)));
    } else {
      item = null;
      if (!paragraph || blank) { paragraph = []; paragraphs.push(paragraph); }
      paragraph.push(line.trim());
    }
    blank = false;
  }

  if (items.length === 0) {
    const whole = text.trim();
    return whole ? { items: [{ id: 'AC1', name: nameOf(whole), text: whole }], general: null } : { items: [], general: null };
  }
  return {
    items: items.map((lines, i) => {
      const itemText = lines.join('\n').trim();
      return { id: `AC${i + 1}`, name: nameOf(itemText), text: itemText };
    }),
    general: paragraphs.length ? paragraphs.map((p) => p.join('\n')).join('\n\n') : null,
  };
}
