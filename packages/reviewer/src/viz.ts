import type { TaskDetail, BranchDiff } from '@agentfactory/core';
import { truncateDiff } from './review.js';

/**
 * The auto-visualization prompt + output salvage. Unlike review.ts's contracts (marker line +
 * fenced JSON), the deliverable here is one raw self-contained HTML document, engine-agnostic —
 * no marker, no system prompt (the configured 'reviewer' instructions are about review judgment,
 * not page authoring).
 */

/** Mirrors MAX_VISUALIZATION_BYTES in web/server/routes/tasks.ts — core's attachVisualization is
 *  uncapped in db mode, so the reviewer enforces the same cap for backend parity. */
export const MAX_VISUALIZATION_BYTES = 4 * 1024 * 1024;

const DEFAULT_MAX_DIFF_CHARS = 120000;

/** Latest result-activity body — the implementer's own summary, context for the lede. */
function latestResult(task: TaskDetail): string {
  const last = task.activity.filter((a) => a.type === 'result').at(-1);
  return last?.body || '(no result summary recorded)';
}

/** The strict raw-HTML output contract (stated early, like review.ts's outputContract). */
function htmlContract(): string {
  return [
    'Respond with EXACTLY one complete self-contained HTML document and nothing else:',
    '- The very first characters of your response must be `<!doctype html>`.',
    '- No markdown code fences, no preamble, no trailing commentary.',
    '- Everything inline (CSS in a <style> tag); the ONLY external resource allowed is the',
    '  Mermaid script: <script src="https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.min.js"></script>',
    "  initialised with mermaid.initialize({ startOnLoad: true, theme: 'dark' }).",
  ].join('\n');
}

/** The page treatment — a distilled /visualize-change: diagram-first, dark, scannable. */
function pageTreatment(): string {
  return [
    'Page treatment (in this order, dark theme, inline CSS, minimal prose — the diagrams carry',
    'the explanation):',
    '1. Title (the task key + a short change title) and a one-line lede saying what the change',
    '   does. If the diff below is truncated, say so in the lede.',
    '2. A Mermaid diagram of the change: prefer a `sequenceDiagram` with `autonumber` showing the',
    '   primary runtime flow (participants labelled "Role (file)"), or a `flowchart` when the',
    '   change is structural rather than a call sequence. Diagram the CHANGED behaviour, not the',
    '   whole system.',
    '3. Only if the change is user-facing: a small hand-built HTML/CSS mockup of the affected UI.',
    '4. A "What changed" file map grouped by area (backend / frontend / tests / infra or similar),',
    '   each entry with a `new` or `mod` badge and a half-line note. Summarise repeated patterns',
    '   rather than listing every file.',
    'Keep it scannable; a reviewer should grasp the change in under a minute.',
  ].join('\n');
}

export interface VisualizationPromptInput {
  task: TaskDetail;
  /** The diffed ref (as shown to the reviewer) and its merge-base diff. */
  branch: string;
  diff: BranchDiff;
  maxDiffChars?: number | undefined;
}

/**
 * Build the visualization prompt: author the self-contained HTML change-overview a human
 * reviewer reads beside the diff. Same `===` context conventions as review.ts.
 */
export function buildVisualizationPrompt(input: VisualizationPromptInput): string {
  const { task, branch, diff, maxDiffChars = DEFAULT_MAX_DIFF_CHARS } = input;
  return [
    'You generate a change-visualization page for a task board. A human reviewer will read it',
    'beside the diff to understand the change quickly. Produce ONE complete self-contained HTML',
    'document that explains this change visually.',
    '',
    htmlContract(),
    '',
    pageTreatment(),
    '',
    `=== TASK ${task.key}: ${task.title} ===`,
    '',
    '=== SPEC ===',
    task.spec,
    '',
    "=== SUBMITTED RESULT (implementer's own summary) ===",
    latestResult(task),
    '',
    '=== BRANCH ===',
    `${branch} (${diff.commits} commit(s) vs ${diff.baseRef})`,
    '',
    '=== DIFF ===',
    truncateDiff(diff.diff, maxDiffChars),
  ].join('\n');
}

/**
 * Salvage the HTML document from an engine's final message. Deliberately minimal ladder:
 * strip one wrapping markdown fence, accept anything starting with `<`, else slice from the
 * first `<!doctype`/`<html`. Returns null when no document is recognisable (burns an attempt).
 */
export function extractHtml(raw: string): string | null {
  let text = raw.trim();
  if (text.startsWith('```')) {
    const lines = text.split('\n');
    lines.shift(); // the opening fence line (``` or ```html)
    if (lines.at(-1)?.trim().startsWith('```')) lines.pop();
    text = lines.join('\n').trim();
  }
  if (text.startsWith('<')) return text;
  const lower = text.toLowerCase();
  const at = (() => {
    const doctype = lower.indexOf('<!doctype');
    if (doctype !== -1) return doctype;
    return lower.indexOf('<html');
  })();
  if (at === -1) return null;
  return text.slice(at);
}
