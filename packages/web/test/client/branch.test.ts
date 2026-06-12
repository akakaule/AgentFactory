import { describe, it, expect } from 'vitest';
import { taskBranch } from '../../client/src/branch.js';

describe('taskBranch', () => {
  it('builds feature/<key>-<kebab-title>', () => {
    expect(taskBranch('AF-12', 'Barcode scanner intake form')).toBe('feature/AF-12-barcode-scanner-intake-form');
  });

  it('collapses punctuation runs and trims edge dashes', () => {
    expect(taskBranch('AF-3', '  Fix: the (Zebra) printer!! ')).toBe('feature/AF-3-fix-the-zebra-printer');
  });

  it('truncates long titles to 40 slug characters without a trailing dash', () => {
    const branch = taskBranch('AF-9', 'A very long title that keeps going and going and going beyond reason');
    const slug = branch.replace('feature/AF-9-', '');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('falls back to feature/<key> when the title has no usable characters', () => {
    expect(taskBranch('AF-7', 'Ærøs øvelse')).toBe('feature/AF-7-r-s-velse');
    expect(taskBranch('AF-7', '!!!')).toBe('feature/AF-7');
  });
});
