import { describe, it, expect } from 'vitest';
import {
  isFailureMarker,
  parseFailureComment,
  summarizeFailure,
  buildFailureComment,
} from '../src/failure.js';

describe('isFailureMarker', () => {
  it('recognises the v1 marker case-insensitively, tolerating leading whitespace', () => {
    expect(isFailureMarker('failure/v1 — timed out')).toBe(true);
    expect(isFailureMarker('Failure/V1 crashed')).toBe(true);
    expect(isFailureMarker('   failure/v1\n{}')).toBe(true);
  });

  it('rejects non-markers and look-alikes', () => {
    expect(isFailureMarker('the session failed')).toBe(false);
    expect(isFailureMarker('the failure/v1 note said')).toBe(false); // must start the body
    expect(isFailureMarker('failure/v10 future')).toBe(false); // word boundary guards v1
  });
});

describe('parseFailureComment', () => {
  it('returns null without the marker', () => {
    expect(parseFailureComment('the worker crashed')).toBeNull();
  });

  it('parses the structured fields from the fenced JSON', () => {
    const body = buildFailureComment({
      reason: 'timeout',
      detail: 'session `ws#AF-1-a1` timed out after 60m',
      source: 'dispatcher',
      attempt: 1,
      maxAttempts: 2,
      body: 'Releasing the claim for retry.',
    });
    const parsed = parseFailureComment(body);
    expect(parsed).toEqual({
      reason: 'timeout',
      detail: 'session `ws#AF-1-a1` timed out after 60m',
      source: 'dispatcher',
      attempt: 1,
      maxAttempts: 2,
    });
  });

  it('keeps an unknown reason string (forward-compatible) and nulls missing fields', () => {
    const parsed = parseFailureComment('failure/v1 weird\n{"reason":"some_new_reason"}');
    expect(parsed).toEqual({ reason: 'some_new_reason', detail: null, source: null, attempt: null, maxAttempts: null });
  });

  it('degrades to null when the JSON is malformed or has no reason', () => {
    expect(parseFailureComment('failure/v1 oops\n{ not json')).toBeNull();
    expect(parseFailureComment('failure/v1 no reason\n{"detail":"x"}')).toBeNull();
    expect(parseFailureComment('failure/v1 just text')).toBeNull();
  });
});

describe('buildFailureComment', () => {
  it('puts the marker + human summary on line 1 so it reads in the timeline', () => {
    const body = buildFailureComment({ reason: 'crashed', detail: 'exited with code 1', source: 'dispatcher', attempt: 2, maxAttempts: 2 });
    expect(body.startsWith('failure/v1 — exited with code 1 (attempt 2/2)')).toBe(true);
    expect(isFailureMarker(body)).toBe(true);
  });
});

describe('summarizeFailure', () => {
  const parsed = (over: Partial<ReturnType<typeof parseFailureComment> & object> = {}) => ({
    reason: 'crashed', detail: 'exited with code 1', source: 'dispatcher', attempt: 1, maxAttempts: 2, ...over,
  });

  it('returns null for no failure or when superseded by later progress', () => {
    expect(summarizeFailure(null, 't', false)).toBeNull();
    expect(summarizeFailure(parsed(), 't', true)).toBeNull();
  });

  it('carries the fields through and stamps the timestamp', () => {
    const s = summarizeFailure(parsed(), '2026-06-18T00:00:00.000Z', false);
    expect(s).toMatchObject({ reason: 'crashed', detail: 'exited with code 1', source: 'dispatcher', attempt: 1, maxAttempts: 2, at: '2026-06-18T00:00:00.000Z' });
  });

  it('flags skipListed for the max_attempts reason', () => {
    expect(summarizeFailure(parsed({ reason: 'max_attempts' }), 't', false)!.skipListed).toBe(true);
  });

  it('flags skipListed once attempt reaches maxAttempts (even for other reasons)', () => {
    expect(summarizeFailure(parsed({ attempt: 2, maxAttempts: 2 }), 't', false)!.skipListed).toBe(true);
    expect(summarizeFailure(parsed({ attempt: 1, maxAttempts: 2 }), 't', false)!.skipListed).toBe(false);
  });
});
