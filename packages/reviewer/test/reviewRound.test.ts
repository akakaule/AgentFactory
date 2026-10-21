import { expect, it } from 'vitest';
import { collectReview, type ReviewRound } from '../src/reviewRound.js';

function round(): ReviewRound {
  return { fingerprint: 'fixture', members: [{ profile: { engine: 'claude' }, prompt: '' }], results: [] };
}
it('accepts Markdown fences embedded in a valid JSON finding', () => {
  const r = round();
  const payload = { verdict: 'findings', findings: [{ title: 'Missing validation', severity: 'error', detail: 'Example: ```json {"bad":true} ```' }] };
  collectReview(r, 'ai-review/v1\n```json\n' + JSON.stringify(payload) + '\n```');
  expect(r.results[0]?.findings[0]?.detail).toBe(payload.findings[0]!.detail);
});
it('reports malformed reviewer JSON without recording a verdict', () => {
  const r = round();
  expect(() => collectReview(r, 'ai-review/v1\n```json\n{"verdict":\n```')).toThrow(/malformed or truncated review JSON/);
  expect(r.results).toEqual([]);
});
