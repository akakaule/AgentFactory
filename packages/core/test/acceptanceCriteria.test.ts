import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { parseAcceptanceCriteria } from '../src/acceptanceCriteria.js';

const AF146 = (JSON.parse(readFileSync(new URL('./fixtures/review-brief/af146-round3.json', import.meta.url), 'utf8')) as { acceptanceCriteria: string }).acceptanceCriteria;

describe('parseAcceptanceCriteria', () => {
  it('numbers AF-146\'s eight criteria AC1–AC8 with their names and keeps the closing rule as general text', () => {
    const { items, general } = parseAcceptanceCriteria(AF146);
    expect(items.map((i) => i.id)).toEqual(['AC1', 'AC2', 'AC3', 'AC4', 'AC5', 'AC6', 'AC7', 'AC8']);
    expect(items.map((i) => i.name)).toEqual([
      'Stale fence', 'Unfenced calls', 'Idempotent submit', 'Race', 'Crash recovery', 'Liveness', 'Reviewer generation', 'Version gate',
    ]);
    expect(items[3]!.text).toBe('Race — two supervisors reserving the same queued task produce exactly one execution record and one successful claim.');
    expect(general).toMatch(/^Each item is covered by an automated test/);
    expect(general).not.toContain('Race');
  });

  it('ids are positional whatever numbers the author typed', () => {
    const { items } = parseAcceptanceCriteria('3. Third — c\n7) Seventh — g');
    expect(items.map((i) => [i.id, i.name])).toEqual([['AC1', 'Third'], ['AC2', 'Seventh']]);
  });

  it('keeps nested bullets and continuation lines with their item, line breaks intact', () => {
    const text = [
      '- Login — the form',
      '  - rejects a wrong password',
      '  - locks after 5 tries',
      '- Logout — clears the session',
      'and the cookie',
    ].join('\n');
    const { items, general } = parseAcceptanceCriteria(text);
    expect(items).toHaveLength(2);
    expect(items[0]!.text).toBe('Login — the form\n  - rejects a wrong password\n  - locks after 5 tries');
    expect(items[1]!.text).toBe('Logout — clears the session\nand the cookie');
    expect(general).toBeNull();
  });

  it('a nested bullet after a blank line stays with its item; a blank line then a plain paragraph ends it', () => {
    const text = ['1. Export — writes a CSV', '', '   - with a header row', '', 'Done when all pass.', '2. Import — reads it back'].join('\n');
    const { items, general } = parseAcceptanceCriteria(text);
    expect(items.map((i) => i.text)).toEqual(['Export — writes a CSV\n\n   - with a header row', 'Import — reads it back']);
    expect(general).toBe('Done when all pass.');
  });

  it('accepts *, • and checkbox bullets and joins intro and outro paragraphs into general', () => {
    const text = ['Done when:', '', '- [ ] Fast: p95 under 200 ms', '* [x] Safe: no new warnings', '• Logged', '', 'Applies to both APIs.'].join('\n');
    const { items, general } = parseAcceptanceCriteria(text);
    expect(items.map((i) => [i.id, i.name, i.text])).toEqual([
      ['AC1', 'Fast', 'Fast: p95 under 200 ms'],
      ['AC2', 'Safe', 'Safe: no new warnings'],
      ['AC3', null, 'Logged'],
    ]);
    expect(general).toBe('Done when:\n\nApplies to both APIs.');
  });

  it('a list line indented deeper than the first item is not a new item', () => {
    const { items } = parseAcceptanceCriteria('  1. Outer — a\n      2. inner\n  3. Next — b');
    expect(items.map((i) => i.text)).toEqual(['Outer — a\n    2. inner', 'Next — b']);
  });

  it('names only short prefixes before the first separator', () => {
    const long = 'x'.repeat(49);
    const { items } = parseAcceptanceCriteria(`1. ${long} — too long\n2. Tight - hyphen\n3. Works – en dash\n4. no separator here`);
    expect(items.map((i) => i.name)).toEqual([null, 'Tight', 'Works', null]);
  });

  it('text without a list becomes a single AC1; empty text gives no items', () => {
    expect(parseAcceptanceCriteria('The export matches the old format byte for byte.\nIt runs nightly.')).toEqual({
      items: [{ id: 'AC1', name: null, text: 'The export matches the old format byte for byte.\nIt runs nightly.' }],
      general: null,
    });
    expect(parseAcceptanceCriteria('  \n\n ')).toEqual({ items: [], general: null });
  });
});
