/**
 * Marker conventions for the delivering-feedback loop, mirroring failure/v1 + ai-review/v1
 * (marker line + fenced JSON).
 *
 * `pr-feedback/v1` — a human pastes a PR-review comment onto a task that's in `delivering`; the
 * marker carries the raw feedback (+ optional author/url). It is the trigger the reviewer supervisor
 * polls for. `feedback-eval/v1` — the evaluator agent's CRITICAL verdict on that feedback:
 * `disposition` (warranted | partial | not_warranted), `reasoning`, and an optional concrete change.
 *
 * The board strips BOTH from the worker's claim payload (mcp content.ts) — the raw AI verdict never
 * reaches the implementer; the human-endorsed `feedback` activity composed by applyFeedbackFix is
 * what the fixing worker acts on.
 */

const PR_FEEDBACK_MARKER = /^pr-feedback\/v1\b/i;
const FEEDBACK_EVAL_MARKER = /^feedback-eval\/v1\b/i;

export const FEEDBACK_DISPOSITIONS = ['warranted', 'partial', 'not_warranted'] as const;
export type FeedbackDisposition = (typeof FEEDBACK_DISPOSITIONS)[number];

export function isPrFeedbackMarker(body: string): boolean { return PR_FEEDBACK_MARKER.test(body.trimStart()); }
export function isFeedbackEvalMarker(body: string): boolean { return FEEDBACK_EVAL_MARKER.test(body.trimStart()); }

/** The fenced ```json block if present, else the first `{…}` span; null if neither parses. */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate: string | null = null;
  if (fence && fence[1] !== undefined) candidate = fence[1];
  else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) candidate = text.slice(start, end + 1);
  }
  if (candidate === null) return null;
  try { return JSON.parse(candidate); } catch { return null; }
}

const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export interface PrFeedbackInput { feedback: string; author?: string | undefined; url?: string | undefined; }
export interface ParsedPrFeedback { feedback: string; author: string | null; url: string | null; }

export function buildPrFeedbackComment(i: PrFeedbackInput): string {
  const json = JSON.stringify({ feedback: i.feedback, author: i.author, url: i.url });
  const head = `pr-feedback/v1 — PR review comment${i.author ? ` from ${i.author}` : ''} to evaluate`;
  return `${head}\n\n\`\`\`json\n${json}\n\`\`\``;
}

export function parsePrFeedbackComment(body: string): ParsedPrFeedback | null {
  if (!isPrFeedbackMarker(body)) return null;
  const json = extractJson(body);
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const feedback = strOrNull(o.feedback);
  if (!feedback) return null;
  return { feedback, author: strOrNull(o.author), url: strOrNull(o.url) };
}

export interface FeedbackEvalInput { disposition: FeedbackDisposition; reasoning: string; suggestedChange?: string | undefined; }
export interface ParsedFeedbackEval { disposition: FeedbackDisposition; reasoning: string; suggestedChange: string | null; }

export function buildFeedbackEvalComment(i: FeedbackEvalInput): string {
  const json = JSON.stringify({ disposition: i.disposition, reasoning: i.reasoning, suggestedChange: i.suggestedChange });
  return `feedback-eval/v1 — ${i.disposition}\n\n\`\`\`json\n${json}\n\`\`\``;
}

export function parseFeedbackEvalComment(body: string): ParsedFeedbackEval | null {
  if (!isFeedbackEvalMarker(body)) return null;
  const json = extractJson(body);
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const disposition = strOrNull(o.disposition);
  if (!disposition || !(FEEDBACK_DISPOSITIONS as readonly string[]).includes(disposition)) return null;
  return { disposition: disposition as FeedbackDisposition, reasoning: strOrNull(o.reasoning) ?? '', suggestedChange: strOrNull(o.suggestedChange) };
}
