import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../../client/src/diff.js';
import {
  MODIFY_MULTI_HUNK, ADDED_FILE, DELETED_FILE, PURE_RENAME, RENAME_WITH_EDITS,
  BINARY_FILE, NO_NEWLINE, MODE_ONLY, MULTI_FILE,
} from './fixtures/diffs.js';

describe('parseUnifiedDiff', () => {
  it('parses an empty diff', () => {
    expect(parseUnifiedDiff('')).toEqual({ files: [], adds: 0, dels: 0 });
  });

  it('parses a multi-hunk modification with correct line numbers', () => {
    const { files, adds, dels } = parseUnifiedDiff(MODIFY_MULTI_HUNK);
    expect(files).toHaveLength(1);
    const f = files[0]!;
    expect(f).toMatchObject({ oldPath: 'src/app.ts', newPath: 'src/app.ts', status: 'modified', binary: false, adds: 3, dels: 2 });
    expect(adds).toBe(3);
    expect(dels).toBe(2);
    expect(f.hunks).toHaveLength(2);

    const h1 = f.hunks[0]!;
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6 });
    expect(h1.lines[0]).toMatchObject({ type: 'context', oldNo: 1, newNo: 1 });
    expect(h1.lines[1]).toMatchObject({ type: 'del', text: "import { b } from './b.js';", oldNo: 2, newNo: null });
    expect(h1.lines[2]).toMatchObject({ type: 'add', text: "import { b, bb } from './b.js';", oldNo: null, newNo: 2 });
    expect(h1.lines[3]).toMatchObject({ type: 'add', oldNo: null, newNo: 3 });
    expect(h1.lines[4]).toMatchObject({ type: 'context', oldNo: 3, newNo: 4 });

    const h2 = f.hunks[1]!;
    expect(h2).toMatchObject({ oldStart: 20, newStart: 21 });
    expect(h2.lines[0]).toMatchObject({ type: 'context', oldNo: 20, newNo: 21 });
    expect(h2.lines[2]).toMatchObject({ type: 'del', oldNo: 22, newNo: null });
    expect(h2.lines[3]).toMatchObject({ type: 'add', oldNo: null, newNo: 23 });
  });

  it('parses an added file', () => {
    const f = parseUnifiedDiff(ADDED_FILE).files[0]!;
    expect(f).toMatchObject({ newPath: 'docs/new.md', status: 'added', adds: 2, dels: 0 });
    expect(f.hunks[0]!.lines.every((l) => l.type === 'add')).toBe(true);
  });

  it('parses a deleted file', () => {
    const f = parseUnifiedDiff(DELETED_FILE).files[0]!;
    expect(f).toMatchObject({ oldPath: 'old.txt', status: 'deleted', adds: 0, dels: 2 });
  });

  it('parses a pure rename (no hunks)', () => {
    const f = parseUnifiedDiff(PURE_RENAME).files[0]!;
    expect(f).toMatchObject({ oldPath: 'README.md', newPath: 'RENAMED.md', status: 'renamed', adds: 0, dels: 0 });
    expect(f.hunks).toHaveLength(0);
  });

  it('parses a rename with edits', () => {
    const f = parseUnifiedDiff(RENAME_WITH_EDITS).files[0]!;
    expect(f).toMatchObject({ oldPath: 'lib/util.ts', newPath: 'lib/utils.ts', status: 'renamed', adds: 1, dels: 1 });
    expect(f.hunks).toHaveLength(1);
  });

  it('flags binary files', () => {
    const f = parseUnifiedDiff(BINARY_FILE).files[0]!;
    expect(f).toMatchObject({ newPath: 'img/logo.png', status: 'added', binary: true, adds: 0, dels: 0 });
    expect(f.hunks).toHaveLength(0);
  });

  it('treats "no newline" markers as meta lines without numbers', () => {
    const f = parseUnifiedDiff(NO_NEWLINE).files[0]!;
    expect(f).toMatchObject({ adds: 1, dels: 1 });
    const types = f.hunks[0]!.lines.map((l) => l.type);
    expect(types).toEqual(['del', 'meta', 'add', 'meta']);
    expect(f.hunks[0]!.lines[1]).toMatchObject({ oldNo: null, newNo: null });
  });

  it('parses a mode-only change as a modification with no hunks', () => {
    const f = parseUnifiedDiff(MODE_ONLY).files[0]!;
    expect(f).toMatchObject({ oldPath: 'script.sh', newPath: 'script.sh', status: 'modified', adds: 0, dels: 0 });
    expect(f.hunks).toHaveLength(0);
  });

  it('aggregates totals across multiple files', () => {
    const { files, adds, dels } = parseUnifiedDiff(MULTI_FILE);
    expect(files.map((f) => f.status)).toEqual(['added', 'modified', 'deleted']);
    expect(adds).toBe(5);
    expect(dels).toBe(4);
  });
});
