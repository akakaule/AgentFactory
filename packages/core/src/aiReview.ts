/**
 * The AI-review marker convention — the single source of truth for recognising and
 * counting an external reviewer's findings. The board never runs the reviewer; an
 * external loop posts findings as a comment whose body begins with `ai-review:`.
 * See docs/superpowers/specs/2026-06-12-ai-review-tier.md for the full contract.
 *
 * Mirrors the client-side parser (packages/web/client/src/aiReview.ts) — keep the two
 * in lockstep until a shared package is extracted (same discipline as branch.ts).
 */
import type { AiReviewSummary } from './types.js';
import type { ActivityStep } from './metrics.js';

/** A comment is an AI review iff its body (leading whitespace ignored) starts with this. */
const MARKER = /^ai-review:/i;

/** The first `{...}` object in the text, parsed leniently; null if none/invalid. */
function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * Parse one comment body into an AI-review verdict, or null if it carries no marker.
 * Count precedence: embedded JSON `findings` (array length, else numeric value), then a
 * tolerant first-line `N finding(s)` read, then 0 (marker present ⇒ clean advisory).
 */
export function parseAiReview(body: string): AiReviewSummary | null {
  const trimmed = body.trimStart();
  if (!MARKER.test(trimmed)) return null;

  const json = extractJson(body);
  if (json && typeof json === 'object') {
    const f = (json as { findings?: unknown }).findings;
    if (Array.isArray(f)) return { findings: f.length };
    if (typeof f === 'number' && Number.isFinite(f)) return { findings: Math.max(0, Math.trunc(f)) };
  }

  const firstLine = trimmed.slice('ai-review:'.length).split(/\r?\n/, 1)[0] ?? '';
  const m = firstLine.match(/(\d+)\s+finding/i);
  if (m) return { findings: parseInt(m[1]!, 10) };

  return { findings: 0 };
}

/**
 * The findings count standing at a task's *final* approval, or null if the task is not
 * done or no ai-review preceded the approval. Walks the status history (id order),
 * tracking the latest ai-review comment and snapshotting it on each `→ done`; the last
 * snapshot wins, so a request-changes round that ends with a clean review reads as 0.
 * This is what makes "approving past open findings" a derivable override — no schema change.
 */
export function findingsAtApproval(steps: ActivityStep[]): number | null {
  let latest: number | null = null;
  let atDone: number | null = null;
  for (const s of steps) {
    if (s.type === 'comment' && s.body) {
      const v = parseAiReview(s.body);
      if (v) latest = v.findings;
    } else if (s.type === 'status_change' && s.toStatus === 'done') {
      atDone = latest;
    }
  }
  return atDone;
}
