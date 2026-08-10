import { describe, it, expect } from 'vitest';
import { buildVisualizationPrompt, extractHtml, sanitizeMermaid, MAX_VISUALIZATION_BYTES } from '../src/viz.js';
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

describe('sanitizeMermaid', () => {
  const wrap = (diagram: string) => `<!doctype html><body><pre class="mermaid">${diagram}</pre></body>`;

  it('replaces statement-splitting semicolons in sequence message text with commas', () => {
    const input = wrap('\nsequenceDiagram\n    A->>B: Validate -1 or 1..365; convert days\n');
    expect(sanitizeMermaid(input)).toBe(wrap('\nsequenceDiagram\n    A->>B: Validate -1 or 1..365, convert days\n'));
  });

  it('fixes Note text too, only after the first colon', () => {
    const input = wrap('\nsequenceDiagram\n    Note over L,C: Fixed windows include Retry-After; concurrency does not\n');
    expect(sanitizeMermaid(input)).toBe(wrap('\nsequenceDiagram\n    Note over L,C: Fixed windows include Retry-After, concurrency does not\n'));
  });

  it('leaves HTML entities intact while fixing bare semicolons', () => {
    const input = wrap('\nsequenceDiagram\n    A->>B: compare a &gt; b; then merge &amp; save\n');
    expect(sanitizeMermaid(input)).toBe(wrap('\nsequenceDiagram\n    A->>B: compare a &gt; b, then merge &amp; save\n'));
  });

  it('leaves non-sequence mermaid blocks and surrounding HTML untouched', () => {
    const flow = wrap('\nflowchart TD\n    A[x; y] --> B\n');
    expect(sanitizeMermaid(flow)).toBe(flow);
    const page = '<!doctype html><body><p>a; b</p></body>';
    expect(sanitizeMermaid(page)).toBe(page);
  });

  it('ignores colon-free lines (alt/else labels, participant lines)', () => {
    const input = wrap('\nsequenceDiagram\n    alt fast path; slow path\n    A->>B: go\n    end\n');
    expect(sanitizeMermaid(input)).toBe(input);
  });

  it('also fixes <div class="mermaid"> blocks (generators use either tag)', () => {
    const input = '<div class="mermaid">\nsequenceDiagram\n    A->>B: stop; drop\n</div>';
    expect(sanitizeMermaid(input)).toBe('<div class="mermaid">\nsequenceDiagram\n    A->>B: stop, drop\n</div>');
  });
});

describe('MAX_VISUALIZATION_BYTES', () => {
  it('mirrors the web route cap', () => {
    expect(MAX_VISUALIZATION_BYTES).toBe(4 * 1024 * 1024);
  });
});
