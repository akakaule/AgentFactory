import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { serializeFeedback, useDiffComments, type DiffComment } from '../../client/src/diffComments.js';

describe('serializeFeedback', () => {
  it('returns the free text unchanged when there are no drafts', () => {
    expect(serializeFeedback([], 'Fix the tests')).toBe('Fix the tests');
  });

  it('returns an empty string when there are neither drafts nor free text', () => {
    expect(serializeFeedback([], '   ')).toBe('');
  });

  it('prepends drafts as file:line - "text" lines, in insertion order, before the free text', () => {
    const drafts: DiffComment[] = [
      { file: 'src/app.ts', line: 42, text: 'this cap should be configurable' },
      { file: 'README.md', line: 7, text: 'typo' },
    ];
    expect(serializeFeedback(drafts, 'and please rebase')).toBe(
      'src/app.ts:42 - "this cap should be configurable"\n' +
        'README.md:7 - "typo"\n' +
        'and please rebase',
    );
  });

  it('serializes drafts alone when the free text is empty', () => {
    expect(serializeFeedback([{ file: 'a.ts', line: 1, text: 'note' }], '')).toBe('a.ts:1 - "note"');
  });

  it('drops drafts whose text is blank and trims the rest', () => {
    const drafts: DiffComment[] = [
      { file: 'a.ts', line: 1, text: '   ' },
      { file: 'b.ts', line: 2, text: '  keep me  ' },
    ];
    expect(serializeFeedback(drafts, '')).toBe('b.ts:2 - "keep me"');
  });
});

describe('useDiffComments', () => {
  it('upserts a comment, replaces it in place on edit, and preserves order', () => {
    const { result } = renderHook(() => useDiffComments());

    act(() => result.current.upsert('a.ts', 1, 'first'));
    act(() => result.current.upsert('b.ts', 2, 'second'));
    expect(result.current.comments).toEqual([
      { file: 'a.ts', line: 1, text: 'first' },
      { file: 'b.ts', line: 2, text: 'second' },
    ]);

    // editing the first comment keeps it at index 0 (no reordering)
    act(() => result.current.upsert('a.ts', 1, 'first edited'));
    expect(result.current.comments).toEqual([
      { file: 'a.ts', line: 1, text: 'first edited' },
      { file: 'b.ts', line: 2, text: 'second' },
    ]);
  });

  it('trims stored text and removes a draft when upserted with blank text', () => {
    const { result } = renderHook(() => useDiffComments());

    act(() => result.current.upsert('a.ts', 1, '  hi  '));
    expect(result.current.comments).toEqual([{ file: 'a.ts', line: 1, text: 'hi' }]);

    act(() => result.current.upsert('a.ts', 1, '   '));
    expect(result.current.comments).toEqual([]);
  });

  it('removes a single draft and clears all drafts (discard)', () => {
    const { result } = renderHook(() => useDiffComments());

    act(() => result.current.upsert('a.ts', 1, 'one'));
    act(() => result.current.upsert('b.ts', 2, 'two'));

    act(() => result.current.remove('a.ts', 1));
    expect(result.current.comments).toEqual([{ file: 'b.ts', line: 2, text: 'two' }]);

    act(() => result.current.clear());
    expect(result.current.comments).toEqual([]);
  });
});
