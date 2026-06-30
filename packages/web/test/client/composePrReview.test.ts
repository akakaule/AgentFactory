import { describe, it, expect } from 'vitest';
import { composePrReview } from '../../client/src/composePrReview.js';
import type { AiReviewFinding } from '../../client/src/types.js';

const f = (o: Partial<AiReviewFinding>): AiReviewFinding => ({
  severity: null, file: null, line: null, title: 'T', detail: null, ...o,
});

describe('composePrReview', () => {
  it('returns an empty string when there is no note and no findings', () => {
    expect(composePrReview([], '')).toBe('');
    expect(composePrReview([], '   ')).toBe('');
  });

  it('emits a note-only review as the trimmed note', () => {
    expect(composePrReview([], '  Looks good overall.  ')).toBe('Looks good overall.');
  });

  it('formats a finding as a markdown bullet with detail, file:line and severity', () => {
    const body = composePrReview([f({ title: 'Unbounded loop', detail: 'no cap', file: 'src/x.ts', line: 42, severity: 'warning' })], '');
    expect(body).toBe('- **Unbounded loop** — no cap (`src/x.ts:42`) _warning_');
  });

  it('omits the locator when there is no file, and :line when line is null', () => {
    expect(composePrReview([f({ title: 'Missing test', severity: 'info' })], '')).toBe('- **Missing test** _info_');
    expect(composePrReview([f({ title: 'Whole-file concern', file: 'src/x.ts' })], '')).toBe('- **Whole-file concern** (`src/x.ts`)');
  });

  it('leads with the note, then a bulleted findings list, separated by a blank line', () => {
    const body = composePrReview(
      [
        f({ title: 'Unbounded loop', detail: 'no cap', file: 'src/x.ts', line: 42, severity: 'warning' }),
        f({ title: 'Missing test', severity: 'info' }),
      ],
      'Two things below.',
    );
    expect(body).toBe(
      'Two things below.\n\n' +
      '- **Unbounded loop** — no cap (`src/x.ts:42`) _warning_\n' +
      '- **Missing test** _info_',
    );
  });
});
