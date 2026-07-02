import { describe, it, expect } from 'vitest';
import { isValidTransition } from '../src/transitions.js';

const VALID: [string, string, string][] = [
  ['backlog','queued','human'], ['queued','in_progress','agent'],
  ['in_progress','in_review','agent'], ['in_progress','blocked','agent'],
  ['in_progress','queued','human'], // release a stranded claim
  ['blocked','in_progress','agent'], ['blocked','queued','human'],
  ['in_review','done','human'], ['in_review','queued','human'],
  ['done','queued','human'], // reopen (e.g. CI failed on the PR)
  ['queued','in_review','human'], ['done','in_review','human'], // pr-review rescue / reopen (kind-gated in updateStatus)
  ['in_review','delivering','human'], // approve with a recognizable git-host origin
  ['delivering','done','agent'], ['delivering','queued','agent'], // watcher: merged+green / CI failed
  ['delivering','done','human'], ['delivering','queued','human'], // force-complete / pull-back
];

describe('isValidTransition', () => {
  it('accepts every spec edge with the correct actor', () => {
    for (const [f, t, by] of VALID) expect(isValidTransition(f as any, t as any, by as any)).toBe(true);
  });
  it('rejects correct edges performed by the wrong actor', () => {
    expect(isValidTransition('in_review','done','agent')).toBe(false);
    expect(isValidTransition('queued','in_progress','human')).toBe(false);
    expect(isValidTransition('in_progress','queued','agent')).toBe(false); // release is human-only
    expect(isValidTransition('done','queued','agent')).toBe(false); // reopen is human-only
    expect(isValidTransition('in_review','delivering','agent')).toBe(false); // only the human approve enters delivery
  });
  it('rejects edges not in the table', () => {
    for (const [f, t] of [['backlog','done'],['queued','blocked'],['backlog','in_progress'],['in_review','in_progress'],['done','done'],
      ['queued','delivering'],['delivering','in_review'],['delivering','blocked'],['done','delivering']] as const)
      expect(isValidTransition(f as any, t as any, 'human')).toBe(false);
  });
});
