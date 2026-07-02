import { describe, it, expect } from 'vitest';
import { isCurationMarker, parseCurationComment, buildCurationComment } from '../src/curation.js';
import type { CurationEntry } from '../src/types.js';

const entry = (over: Partial<CurationEntry> = {}): CurationEntry =>
  ({ severity: 'warning', file: 'src/x.ts', line: 42, title: 'Unbounded loop', disposition: 'forwarded', ...over });

describe('isCurationMarker', () => {
  it('matches a curation/v1 body regardless of leading whitespace/case', () => {
    expect(isCurationMarker('curation/v1 — 1 forwarded')).toBe(true);
    expect(isCurationMarker('  Curation/V1\n{...}')).toBe(true);
  });
  it('does not match plain comments or other markers', () => {
    expect(isCurationMarker('ai-review/v1 — 1 finding')).toBe(false);
    expect(isCurationMarker('curation is hard')).toBe(false);
    expect(isCurationMarker('a note about curation/v1')).toBe(false);
  });
});

describe('buildCurationComment ↔ parseCurationComment round-trip', () => {
  it('round-trips reviewer + every disposition', () => {
    const dispositions = [
      entry({ title: 'Keep', disposition: 'forwarded' }),
      entry({ title: 'Drop', disposition: 'dismissed', file: null, line: null }),
      entry({ title: 'Skip', disposition: 'overridden', severity: 'error' }),
    ];
    const body = buildCurationComment('codex', dispositions);
    expect(isCurationMarker(body)).toBe(true);

    const parsed = parseCurationComment(body)!;
    expect(parsed.reviewer).toBe('codex');
    expect(parsed.dispositions).toEqual(dispositions);
  });

  it('summarizes the non-zero disposition counts and the reviewer in the head line', () => {
    const body = buildCurationComment('codex', [
      entry({ disposition: 'forwarded' }), entry({ disposition: 'forwarded' }), entry({ disposition: 'dismissed' }),
    ]);
    expect(body.split('\n')[0]).toBe('curation/v1 — 2 forwarded, 1 dismissed (codex)');
  });

  it('omits the reviewer suffix when reviewer is null', () => {
    const body = buildCurationComment(null, [entry({ disposition: 'overridden' })]);
    expect(body.split('\n')[0]).toBe('curation/v1 — 1 overridden');
    expect(parseCurationComment(body)!.reviewer).toBeNull();
  });
});

describe('parseCurationComment', () => {
  it('returns null for a non-marker body', () => {
    expect(parseCurationComment('ai-review/v1 — 1 finding')).toBeNull();
    expect(parseCurationComment('just a comment')).toBeNull();
  });

  it('degrades a marked-but-malformed body to null (no ledger)', () => {
    expect(parseCurationComment('curation/v1 broken\n{ not json')).toBeNull();
  });

  it('returns null when dispositions is missing or empty', () => {
    expect(parseCurationComment('curation/v1\n```json\n{"reviewer":"codex"}\n```')).toBeNull();
    expect(parseCurationComment('curation/v1\n```json\n{"reviewer":"codex","dispositions":[]}\n```')).toBeNull();
  });

  it('drops entries without a title or with an unknown disposition, keeping the valid ones', () => {
    const body =
      'curation/v1\n```json\n' +
      JSON.stringify({
        reviewer: 'codex',
        dispositions: [
          { title: 'ok', disposition: 'forwarded', severity: 'warning', file: 'a.ts', line: 1 },
          { title: '', disposition: 'forwarded' }, // no title → dropped
          { title: 'bad-disp', disposition: 'maybe' }, // unknown disposition → dropped
        ],
      }) +
      '\n```';
    const parsed = parseCurationComment(body)!;
    expect(parsed.dispositions).toHaveLength(1);
    expect(parsed.dispositions[0]).toMatchObject({ title: 'ok', disposition: 'forwarded' });
  });
});
