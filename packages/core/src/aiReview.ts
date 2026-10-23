/**
 * The `ai-review/v1` marker convention — the single source of truth for recognising,
 * parsing, and counting an external reviewer's findings. The board never runs the
 * reviewer; an external loop posts findings as a comment whose body begins with the
 * marker `ai-review/v1`, followed by a short human-readable summary and a fenced JSON
 * block: `{ reviewer, verdict, findings: [{ severity, file, line?, title, detail }] }`.
 * See docs/superpowers/specs/2026-06-12-ai-review-tier.md for the full contract.
 */
import type { AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity, ReviewBinding, ReviewRevision } from './types.js';
import type { ActivityStep } from './metrics.js';
import { parseConsensusReview, type ReviewConsensus } from './reviewConsensus.js';

/** A comment is an AI review iff its body (leading whitespace ignored) starts with this. */
const MARKER = /^ai-review\/v[12]\b/i;

/**
 * True iff a comment body carries the `ai-review/v1` marker, regardless of whether the
 * embedded JSON is well-formed. The agent-facing MCP strip and the SQL prefilter key on
 * this — a marked-but-malformed review must still never leak uncurated findings to the
 * implementing agent. (Rendering, by contrast, requires a *parseable* review; a malformed
 * one degrades to a plain comment — see `parseAiReviewComment`.)
 */
export function isAiReviewMarker(body: string): boolean {
  return MARKER.test(body.trimStart());
}

export interface ParsedAiReview {
  reviewer: string | null;
  findings: AiReviewFinding[];
  consensus?: ReviewConsensus;
  revision?: ReviewRevision | null;
}

/** The fenced ```json block if present, else the first `{…}` span; null if neither parses. */
function extractJson(text: string): unknown {
  // Discussion history contains escaped Markdown fences inside JSON strings. Only a
  // standalone closing fence terminates a multiline payload, not those embedded fences.
  const fence = text.match(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i)
    ?? text.match(/```(?:json)?\s*([\s\S]*?)```/i);
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

const SEVERITIES: readonly string[] = ['info', 'warning', 'error'];
const CRITERION_ID = /^AC\d+$/;
const MAX_CRITERIA = 10;

/**
 * A finding's criterion ids, cleaned: uppercased, deduped, non-ids dropped, at most 10. `[]` is
 * kept (the reviewer says it is outside the criteria); a non-array is undefined (not reported).
 */
export function normalizeCriteria(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const ids = raw.filter((v): v is string => typeof v === 'string').map((v) => v.trim().toUpperCase()).filter((v) => CRITERION_ID.test(v));
  return [...new Set(ids)].slice(0, MAX_CRITERIA);
}

/** A finding's remedy, or undefined when blank. */
export function normalizeFix(raw: unknown): string | undefined {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

function normalizeFinding(raw: unknown): AiReviewFinding | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null; // a titleless finding is not renderable — drop it
  const severity: AiReviewSeverity | null =
    typeof o.severity === 'string' && SEVERITIES.includes(o.severity) ? (o.severity as AiReviewSeverity) : null;
  const file = typeof o.file === 'string' && o.file.trim() ? o.file.trim() : null;
  const line = typeof o.line === 'number' && Number.isFinite(o.line) ? Math.trunc(o.line) : null;
  const detail = typeof o.detail === 'string' && o.detail.trim() ? o.detail.trim() : null;
  // absent keys stay absent: the consensus schema is strict and these findings become candidates
  const criteria = normalizeCriteria(o.criteria);
  const fix = normalizeFix(o.fix);
  return { severity, file, line, title, detail, ...(criteria !== undefined ? { criteria } : {}), ...(fix !== undefined ? { fix } : {}) };
}

/**
 * Parse a comment body into a structured `ai-review/v1` verdict, or null when the body
 * carries no marker OR the embedded JSON is malformed / lacks a `findings` array. A
 * malformed marker comment thus "degrades to a plain comment" for rendering: no chip,
 * no checklist. (It is still hidden from the agent — see `isAiReviewMarker`.)
 */
export function parseAiReviewComment(body: string): ParsedAiReview | null {
  if (!isAiReviewMarker(body)) return null;
  const json = extractJson(body);
  if (/^ai-review\/v2\b/i.test(body.trimStart())) {
    const review = parseConsensusReview(json);
    return review ? { reviewer: review.reviewer, findings: review.findings, consensus: review.consensus, ...withRevision(body) } : null;
  }
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return null;
  const findings = obj.findings
    .map(normalizeFinding)
    .filter((f): f is AiReviewFinding => f !== null);
  const reviewer = typeof obj.reviewer === 'string' && obj.reviewer.trim() ? obj.reviewer.trim() : null;
  return { reviewer, findings, ...withRevision(body) };
}

/**
 * Build the chip/drawer verdict from a parsed review and a freshness flag.
 * `superseded` = a result activity newer than this review exists ⇒ the verdict reads
 * `pending` (a fresh re-review is due). Otherwise `clean` (0) or `findings` (N>0).
 */
export function summarizeAiReview(parsed: ParsedAiReview | null, superseded: boolean, binding: ReviewBinding = parsed?.revision ? 'current' : 'legacy'): AiReviewSummary | null {
  if (!parsed) return null;
  const findings = parsed.findings.length;
  // a review bound to a superseded submission or a moved head is not proof for what is there now
  const verdict: AiReviewVerdict = superseded || binding === 'stale' || binding === 'superseded' ? 'pending' : parsed.consensus?.status === 'disputed' ? 'disputed' : findings > 0 ? 'findings' : 'clean';
  return { verdict, findings, reviewer: parsed.reviewer, items: parsed.findings, ...(parsed.consensus ? { consensus: parsed.consensus } : {}), binding, revision: parsed.revision ?? null };
}

/**
 * The unresolved issue count (confirmed findings plus disputes) at final approval, or null when the approved
 * result had no current AI review — none was ever posted, OR a newer result superseded
 * the last review (pending at done). Walks the status history (id order): an ai-review
 * comment sets the current count, a `result` clears it (the new submission is unreviewed
 * until the reviewer re-runs), and each `→ done` snapshots the current value; the last
 * snapshot wins. null ⇒ the task is excluded from the override-rate KPI (n/m discipline);
 * 0 ⇒ a clean approval; N>0 ⇒ approving past open findings, i.e. an override.
 */
export function findingsAtApproval(steps: ActivityStep[]): number | null {
  let current: number | null = null;
  let atDone: number | null = null;
  for (const s of steps) {
    if (s.type === 'comment' && s.body) {
      const p = parseAiReviewComment(s.body);
      if (p) current = p.findings.length + (p.consensus?.candidates.filter(c => c.outcome === 'disputed').length ?? 0);
    } else if (s.type === 'result') {
      current = null; // a fresh result supersedes the prior review ⇒ pending until re-reviewed
    } else if (s.type === 'status_change' && s.toStatus === 'done') {
      atDone = current;
    }
  }
  return atDone;
}

/**
 * The revision line a reviewer appends to its ai-review comment (outside the JSON, so v1/v2
 * parsing is untouched): which submission it reviewed and the head/base it diffed. A review
 * without one is a legacy, unbound review — readable, never proof for a newer revision.
 */
const REVISION_LINE = /^review-revision\/v1 submission=#(\d+)(?: head=([0-9a-f]{40,64}))?(?: base=([0-9a-f]{40,64}))?[ \t]*\r?$/gm;

export function formatReviewRevision(r: { submissionId: number; headSha?: string | null | undefined; baseSha?: string | null | undefined }): string {
  return `review-revision/v1 submission=#${r.submissionId}${r.headSha ? ` head=${r.headSha}` : ''}${r.baseSha ? ` base=${r.baseSha}` : ''}`;
}

/** Spread helper: the revision key only when the review is bound (keeps unbound parses unchanged). */
function withRevision(body: string): { revision?: ReviewRevision } {
  const revision = parseReviewRevision(body);
  return revision ? { revision } : {};
}

/** The last revision line in a review body, or null for an unbound (legacy) review. */
export function parseReviewRevision(body: string): ReviewRevision | null {
  let last: RegExpExecArray | null = null;
  for (const m of body.matchAll(REVISION_LINE)) last = m;
  if (!last) return null;
  return { submissionId: Number(last[1]), headSha: last[2] ?? null, ...(last[3] ? { baseSha: last[3] } : {}) };
}
