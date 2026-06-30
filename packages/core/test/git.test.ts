import { describe, it, expect } from 'vitest';
import { refFromLabel } from '../src/git.js';

// A branch-kind link's label is the display string an agent submits. By convention it
// starts with the bare branch ref, but agents sometimes decorate it with a trailing
// annotation (e.g. "(PR 4703 source — conflict fix pushed here)"). refFromLabel recovers
// the safe git ref so a decorated label never poisons the diff / auto-review pipeline.
describe('refFromLabel', () => {
  it('returns a clean label unchanged', () => {
    expect(refFromLabel('feature/AF-1-do-the-thing')).toBe('feature/AF-1-do-the-thing');
    expect(refFromLabel('task/AF-1')).toBe('task/AF-1');
  });

  it('strips a trailing parenthetical annotation', () => {
    expect(
      refFromLabel('feature/AF-18-ab-16211-fjern-individualsavings-fra-sta (PR 4703 source — conflict fix pushed here)'),
    ).toBe('feature/AF-18-ab-16211-fjern-individualsavings-fra-sta');
  });

  it('accepts real-world refs git allows — punctuation, parens, non-ASCII, double dashes', () => {
    // An Azure DevOps PR head ref (no whitespace, so the whole label is the ref): '&', '(',
    // ')', the non-ASCII 'æ', and '--' are all legal in a git ref and must survive the guard.
    const ado = 'sib/User-Story-63309--ID4--Stabil-integration-mod-Dynamics-F&O-ved-store-mængder-(FO-Adapter)';
    expect(refFromLabel(ado)).toBe(ado);
    expect(refFromLabel('users/john.doe/feature_x')).toBe('users/john.doe/feature_x');
  });

  it('still rejects refs git forbids or that would inject', () => {
    for (const bad of ['a:b', 'a~1', 'a^', 'wild*card', 'opt?', 'br[ack]', 'back\\slash', 'peel@{1}']) {
      expect(refFromLabel(bad)).toBeNull();
    }
  });

  it('takes the leading whitespace-delimited token', () => {
    expect(refFromLabel('feature/AF-24 (PR 4702 source, fast-forwarded)')).toBe('feature/AF-24');
    expect(refFromLabel('  feature/AF-7   extra words ')).toBe('feature/AF-7');
  });

  it('returns null when the leading token is not a safe ref (no silent fallback)', () => {
    expect(refFromLabel('--output=evil')).toBeNull();   // option injection
    expect(refFromLabel('-- something')).toBeNull();     // leading dash
    expect(refFromLabel('a..b annotation')).toBeNull();  // revision range
    expect(refFromLabel('')).toBeNull();
    expect(refFromLabel('   ')).toBeNull();
  });
});
