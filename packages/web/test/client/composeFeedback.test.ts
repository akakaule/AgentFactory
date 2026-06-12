import { describe, it, expect } from 'vitest';
import { composeFeedback } from '../../client/src/composeFeedback.js';
import type { AiReviewFinding } from '../../client/src/types.js';

const f = (over: Partial<AiReviewFinding> = {}): AiReviewFinding =>
  ({ severity: null, file: null, line: null, title: 'A finding', detail: null, ...over });

describe('composeFeedback', () => {
  it('attributes each selected finding to the reviewer with a file:line locator', () => {
    const body = composeFeedback(
      [f({ title: 'Unbounded loop', file: 'src/x.ts', line: 42, detail: 'no cap' })],
      'codex', '', true,
    );
    expect(body).toBe('[reviewer-codex] Unbounded loop — no cap (src/x.ts:42)');
  });

  it('appends the human note attributed [human] when a review is present', () => {
    const body = composeFeedback([f({ title: 'X' })], 'codex', 'also rename foo', true);
    expect(body).toBe('[reviewer-codex] X\n\n[human] also rename foo');
  });

  it('leaves the human note unattributed when no AI review is present', () => {
    expect(composeFeedback([], null, 'Fix the tests', false)).toBe('Fix the tests');
  });

  it('omits unselected findings entirely (they are simply not in the array)', () => {
    const body = composeFeedback([f({ title: 'kept' })], 'codex', '', true);
    expect(body).toContain('kept');
    expect(body).not.toContain('dropped');
  });

  it('falls back to a bare [reviewer] tag when the reviewer name is unknown', () => {
    expect(composeFeedback([f({ title: 'X' })], null, '', true)).toBe('[reviewer] X');
  });

  it('returns empty string when nothing is selected and no note is written', () => {
    expect(composeFeedback([], 'codex', '   ', true)).toBe('');
  });

  it('uses just the file when there is no line', () => {
    expect(composeFeedback([f({ title: 'X', file: 'src/y.ts' })], 'codex', '', true))
      .toBe('[reviewer-codex] X (src/y.ts)');
  });
});
