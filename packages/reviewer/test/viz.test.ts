import { describe, it, expect } from 'vitest';
import { buildVisualizationPrompt, extractHtml, MAX_VISUALIZATION_BYTES } from '../src/viz.js';
import { makeCore, seedInReview, sampleHtml } from './helpers.js';

function promptFor(diffText = 'diff --git a/a.ts b/a.ts\n+code', maxDiffChars?: number) {
  const core = makeCore();
  const key = seedInReview(core, 'ws', 'add feature');
  const task = core.getTask(key);
  return buildVisualizationPrompt({
    task,
    branch: 'feature/af-x',
    diff: { baseRef: 'main', diff: diffText, commits: 2 },
    maxDiffChars,
  });
}

describe('buildVisualizationPrompt', () => {
  it('carries the raw-HTML contract, the treatment, and every context section', () => {
    const prompt = promptFor();
    expect(prompt).toContain('<!doctype html>');
    expect(prompt).toContain('No markdown code fences');
    expect(prompt).toContain('cdn.jsdelivr.net/npm/mermaid@11');
    expect(prompt).toContain('sequenceDiagram');
    expect(prompt).toContain('=== TASK ');
    expect(prompt).toContain('=== SPEC ===');
    expect(prompt).toContain('=== SUBMITTED RESULT');
    expect(prompt).toContain('=== BRANCH ===');
    expect(prompt).toContain('feature/af-x (2 commit(s) vs main)');
    expect(prompt).toContain('=== DIFF ===');
    expect(prompt).toContain('+code');
    // no ai-review contract bleed
    expect(prompt).not.toContain('ai-review/v1');
  });

  it('truncates an over-limit diff and flags the cut in-band', () => {
    const prompt = promptFor('x'.repeat(500), 100);
    expect(prompt).toContain('diff truncated at 100 chars');
    expect(prompt).not.toContain('x'.repeat(101));
  });
});

describe('extractHtml', () => {
  it('passes a clean document through untouched', () => {
    const html = sampleHtml();
    expect(extractHtml(html)).toBe(html);
  });

  it('strips a wrapping markdown fence (with and without the html info string)', () => {
    const html = sampleHtml();
    expect(extractHtml('```html\n' + html + '\n```')).toBe(html);
    expect(extractHtml('```\n' + html + '\n```')).toBe(html);
  });

  it('slices from the first doctype after a sentence of preamble', () => {
    const html = sampleHtml();
    expect(extractHtml(`Here is the visualization you asked for:\n\n${html}`)).toBe(html);
  });

  it('slices from <html when no doctype is present', () => {
    const doc = '<html><body>hi</body></html>';
    expect(extractHtml(`Sure!\n${doc}`)).toBe(doc);
  });

  it('rejects prose-only and empty output', () => {
    expect(extractHtml('I could not generate a page for this diff.')).toBeNull();
    expect(extractHtml('')).toBeNull();
    expect(extractHtml('```\n\n```')).toBeNull();
  });
});

describe('MAX_VISUALIZATION_BYTES', () => {
  it('mirrors the web route cap', () => {
    expect(MAX_VISUALIZATION_BYTES).toBe(4 * 1024 * 1024);
  });
});
