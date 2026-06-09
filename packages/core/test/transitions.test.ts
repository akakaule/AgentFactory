import { describe, it, expect } from 'vitest';
import { isValidTransition } from '../src/transitions.js';

const VALID: [string, string, string][] = [
  ['backlog','queued','human'], ['queued','in_progress','agent'],
  ['in_progress','in_review','agent'], ['in_progress','blocked','agent'],
  ['blocked','in_progress','agent'], ['blocked','queued','human'],
  ['in_review','done','human'], ['in_review','queued','human'],
];

describe('isValidTransition', () => {
  it('accepts every spec edge with the correct actor', () => {
    for (const [f, t, by] of VALID) expect(isValidTransition(f as any, t as any, by as any)).toBe(true);
  });
  it('rejects correct edges performed by the wrong actor', () => {
    expect(isValidTransition('in_review','done','agent')).toBe(false);
    expect(isValidTransition('queued','in_progress','human')).toBe(false);
  });
  it('rejects edges not in the table', () => {
    for (const [f, t] of [['backlog','done'],['queued','in_review'],['in_progress','queued'],['done','queued'],['backlog','in_progress'],['in_review','in_progress'],['done','done']] as const)
      expect(isValidTransition(f as any, t as any, 'human')).toBe(false);
  });
});
