import { describe, it, expect } from 'vitest';
import { buildCriteriaClaimsComment, isCriteriaClaimsMarker, parseCriteriaClaims } from '../src/criteriaClaims.js';

describe('criteria-claims/v1 marker', () => {
  const claims = [{ id: 'AC1', claim: 'Proven by race.test.ts — "two supervisors" case.' }, { id: 'AC3', claim: 'Logs one line.' }];

  it('round-trips through the comment body', () => {
    const body = buildCriteriaClaimsComment(claims);
    expect(body.startsWith('criteria-claims/v1')).toBe(true);
    expect(isCriteriaClaimsMarker(body)).toBe(true);
    expect(parseCriteriaClaims(body)).toEqual(claims);
  });

  it('recognises the marker only at the start of the body', () => {
    expect(isCriteriaClaimsMarker('  criteria-claims/v1\n{}')).toBe(true);
    expect(isCriteriaClaimsMarker('see criteria-claims/v1')).toBe(false);
    expect(isCriteriaClaimsMarker('criteria-claims/v10')).toBe(false);
  });

  it('a malformed or unmarked body parses to null', () => {
    expect(parseCriteriaClaims('criteria-claims/v1\n```json\n{ nope\n```')).toBeNull();
    expect(parseCriteriaClaims('criteria-claims/v1\n```json\n{"claims":[{"id":"AC1"}]}\n```')).toBeNull();
    expect(parseCriteriaClaims('a plain comment')).toBeNull();
  });
});
