import { describe, it, expect } from 'vitest';
import { isValidTransition } from '../src/transitions.js';

const VALID: [string, string, string][] = [
  ['backlog','queued','human'], ['queued','in_progress','agent'],
  ['in_progress','in_review','agent'], ['in_progress','blocked','agent'],
  ['in_progress','queued','human'], // release a stranded claim
  ['blocked','in_progress','agent'], ['blocked','queued','human'],
  ['in_review','done','human'], ['in_review','queued','human'],
  ['in_review','queued','agent'], // doc-stage auto-approve (gated out of updateStatus)
  ['done','queued','human'], // reopen (e.g. CI failed on the PR)
  ['queued','in_review','human'], ['done','in_review','human'], // pr-review rescue / reopen (kind-gated in updateStatus)
  ['in_review','delivering','human'], // approve with a recognizable git-host origin
  ['delivering','done','agent'], ['delivering','queued','agent'], // watcher: merged+green / CI failed
  ['delivering','done','human'], ['delivering','queued','human'], // force-complete / pull-back
  ['queued','done','agent'], ['in_progress','done','agent'],
  ['blocked','done','agent'], ['in_review','done','agent'], // guarded merged-delivery recovery
];

describe('isValidTransition', () => {
  it('accepts every spec edge with the correct actor', () => {
    for (const [f, t, by] of VALID) expect(isValidTransition(f as any, t as any, by as any)).toBe(true);
  });
  it('rejects correct edges performed by the wrong actor', () => {
    expect(isValidTransition('blocked','done','human')).toBe(false);
    expect(isValidTransition('queued','in_progress','human')).toBe(false);
    expect(isValidTransition('in_progress','queued','agent')).toBe(false); // release is human-only
    expect(isValidTransition('done','queued','agent')).toBe(false); // reopen is human-only
    // in_review → delivering by an agent exists only for the auto-approve policy; ops/updateStatus.ts
    // refuses it as a raw move (autoApprove.test.ts), so an agent still cannot approve its own review.
    expect(isValidTransition('in_review','delivering','agent')).toBe(true);
    expect(isValidTransition('in_review','done','human')).toBe(true);
  });
  it('rejects edges not in the table', () => {
    for (const [f, t] of [['backlog','done'],['queued','blocked'],['backlog','in_progress'],['in_review','in_progress'],['done','done'],
      ['queued','delivering'],['delivering','in_review'],['delivering','blocked'],['done','delivering']] as const)
      expect(isValidTransition(f as any, t as any, 'human')).toBe(false);
  });
});
