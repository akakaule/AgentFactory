/**
 * The `failure/v1` marker convention — the single source of truth for recognising and
 * parsing a supervisor failure note. When the dispatcher releases/skip-lists a crashed or
 * timed-out claim, or the reviewer gives up on a review, it posts a comment whose body
 * begins with the marker `failure/v1`, followed by a one-line human summary and a fenced
 * JSON block: `{ reason, detail, source, attempt, maxAttempts }`. The board derives a
 * `FailureSummary` from the latest such comment so the operator sees *why* a task is stuck
 * (instead of scrolling raw logs) — mirrors the `ai-review/v1` convention in aiReview.ts.
 *
 * Unlike curated ai-review findings, a failure note is NOT stripped from the agent's claim
 * payload: the prior-failure reason is useful context for the retrying session.
 */
import type { FailureSummary } from './types.js';

/** A comment is a failure note iff its body (leading whitespace ignored) starts with this. */
const MARKER = /^failure\/v1\b/i;

/**
 * The `restart/v1` marker convention — an operator "restart" note. Posted (human actor) when a
 * skip-listed task is restarted from the board: it supersedes the task's latest `failure/v1`
 * note the same way a fresh result does, so the derived FailureSummary clears (the board drops
 * the skip-list chip) and the owning supervisor — which follows the derived failure state —
 * forgets the task's burned attempts and retries it with a fresh budget, without a bounce.
 */
const RESTART_MARKER = /^restart\/v1\b/i;

/** True iff a comment body carries the `restart/v1` marker (an operator restart note). */
export function isRestartMarker(body: string): boolean {
  return RESTART_MARKER.test(body.trimStart());
}

/** Compose a `restart/v1` comment body: the marker + a one-line human reason. */
export function buildRestartComment(detail: string): string {
  return `restart/v1 — ${detail}`;
}

/**
 * Reasons the supervisors emit today. The parser keeps any non-empty string as the reason
 * (forward-compatible with new emitters); this list is just the set the UI styles and labels.
 */
export const FAILURE_REASONS = ['timeout', 'crashed', 'stale', 'permission_denied', 'max_attempts', 'review_failed', 'ci_failed', 'pr_closed', 'merge_conflict'] as const;
export type FailureReason = (typeof FAILURE_REASONS)[number];

/** True iff a comment body carries the `failure/v1` marker (regardless of JSON well-formedness). */
export function isFailureMarker(body: string): boolean {
  return MARKER.test(body.trimStart());
}

/** The fenced ```json block if present, else the first `{…}` span; null if neither parses. */
function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let candidate: string | null = null;
  if (fence && fence[1] !== undefined) {
    candidate = fence[1];
  } else {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end > start) candidate = text.slice(start, end + 1);
  }
  if (candidate === null) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

export interface ParsedFailure {
  reason: string;
  detail: string | null;
  source: string | null;
  attempt: number | null;
  maxAttempts: number | null;
}

const intOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * Parse a comment body into a structured failure, or null when the body carries no marker OR
 * the embedded JSON is malformed / lacks a `reason`. A malformed marker comment degrades to a
 * plain comment (no chip) — same contract as parseAiReviewComment.
 */
export function parseFailureComment(body: string): ParsedFailure | null {
  if (!isFailureMarker(body)) return null;
  const json = extractJson(body);
  if (!json || typeof json !== 'object') return null;
  const o = json as Record<string, unknown>;
  const reason = strOrNull(o.reason);
  if (!reason) return null; // a reasonless failure is not renderable — drop it
  return {
    reason,
    detail: strOrNull(o.detail),
    source: strOrNull(o.source),
    attempt: intOrNull(o.attempt),
    maxAttempts: intOrNull(o.maxAttempts),
  };
}

/**
 * Build the `FailureSummary` from a parsed failure + the comment timestamp. `superseded` = a
 * result activity newer than this failure exists ⇒ the failure was cleared by a successful
 * submission, so it is no longer current (returns null). `skipListed` = out of attempts (reason
 * `max_attempts`, or attempt ≥ maxAttempts) ⇒ no further auto-retry; a human must intervene.
 */
export function summarizeFailure(parsed: ParsedFailure | null, at: string, superseded: boolean): FailureSummary | null {
  if (!parsed || superseded) return null;
  const skipListed =
    parsed.reason === 'max_attempts' ||
    (parsed.attempt !== null && parsed.maxAttempts !== null && parsed.attempt >= parsed.maxAttempts);
  return {
    reason: parsed.reason,
    detail: parsed.detail,
    source: parsed.source,
    attempt: parsed.attempt,
    maxAttempts: parsed.maxAttempts,
    skipListed,
    at,
  };
}

export interface FailureCommentInput {
  reason: FailureReason | string;
  detail: string;            // one-line human reason, e.g. "session `x` timed out after 60m"
  source: 'dispatcher' | 'reviewer' | 'watcher' | string;
  // attempt bookkeeping is the dispatcher/reviewer retry loop's; the watcher's delivery bounces
  // (ci_failed / pr_closed / merge_conflict) have no attempt budget, so both are optional and
  // omitted together
  attempt?: number | undefined;
  maxAttempts?: number | undefined;
  body?: string;             // extra human text appended below (e.g. a fenced log tail)
}

/**
 * Compose a `failure/v1` comment body: the marker + human summary on line 1 (so it reads fine
 * in the activity timeline), then the machine-readable JSON, then any extra body (the log tail).
 * The supervisors call this so the format lives in exactly one place.
 */
export function buildFailureComment(i: FailureCommentInput): string {
  const json = JSON.stringify({
    reason: i.reason,
    detail: i.detail,
    source: i.source,
    // undefined drops out of JSON.stringify ⇒ the parser's intOrNull reads them back as null
    attempt: i.attempt,
    maxAttempts: i.maxAttempts,
  });
  const suffix = i.attempt !== undefined && i.maxAttempts !== undefined ? ` (attempt ${i.attempt}/${i.maxAttempts})` : '';
  const head = `failure/v1 — ${i.detail}${suffix}`;
  const extra = i.body && i.body.trim() ? `\n\n${i.body.trim()}` : '';
  return `${head}\n\n\`\`\`json\n${json}\n\`\`\`${extra}`;
}
