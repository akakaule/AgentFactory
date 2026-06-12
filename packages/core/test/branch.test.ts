import { describe, it, expect } from 'vitest';
import { featureBranch, kebabTitle } from '../src/branch.js';

describe('kebabTitle', () => {
  it('lowercases and collapses non-alphanumeric runs to single dashes', () => {
    expect(kebabTitle('Barcode scanner intake form')).toBe('barcode-scanner-intake-form');
  });

  it('trims edge punctuation and collapses runs', () => {
    expect(kebabTitle('  Fix: the (Zebra) printer!! ')).toBe('fix-the-zebra-printer');
  });

  it('truncates to 40 characters without leaving a trailing dash', () => {
    const slug = kebabTitle('A very long title that keeps going and going and going beyond reason');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith('-')).toBe(false);
  });

  it('drops non-ascii letters (charset is a-z0-9 only)', () => {
    expect(kebabTitle('Ærøs øvelse')).toBe('r-s-velse');
    expect(kebabTitle('!!!')).toBe('');
  });
});

describe('featureBranch', () => {
  it('builds feature/<key>-<kebab-title>', () => {
    expect(featureBranch('AF-12', 'Barcode scanner intake form')).toBe('feature/AF-12-barcode-scanner-intake-form');
  });

  it('falls back to feature/<key> when the title has no usable characters', () => {
    expect(featureBranch('AF-7', '!!!')).toBe('feature/AF-7');
  });

  it('is deterministic (matches the client-side taskBranch rule)', () => {
    expect(featureBranch('AF-3', '  Fix: the (Zebra) printer!! ')).toBe('feature/AF-3-fix-the-zebra-printer');
    expect(featureBranch('AF-7', 'Ærøs øvelse')).toBe('feature/AF-7-r-s-velse');
  });
});
