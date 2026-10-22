import { describe, it, expect } from 'vitest';
import { hunksAt, findDiffFile } from '../../client/src/components/ReviewEvidence.js';
import { parseUnifiedDiff } from '../../client/src/diff.js';

const diff = parseUnifiedDiff([
  'diff --git a/src/a.ts b/src/a.ts',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -10,2 +9,0 @@',
  '-gone();',
  '-gone2();',
  '@@ -40,2 +38,3 @@',
  ' keep();',
  '+added();',
  ' keep2();',
  '',
].join('\n'));

describe('evidence hunk lookup', () => {
  it('finds the hunk whose new-side lines contain the line; a deletion-only hunk contains none', () => {
    const file = findDiffFile(diff, 'src/a.ts')!;
    expect(hunksAt(file, 9)).toEqual([]);
    expect(hunksAt(file, 39).map((h) => h.newStart)).toEqual([38]);
    expect(hunksAt(file, 41)).toEqual([]);
  });

  it('matches a path by suffix only when exactly one file ends with it', () => {
    expect(findDiffFile(diff, 'a.ts')?.newPath).toBe('src/a.ts');
    expect(findDiffFile(diff, './src/a.ts')?.newPath).toBe('src/a.ts');
    expect(findDiffFile(diff, 'b.ts')).toBeNull();
  });
});
