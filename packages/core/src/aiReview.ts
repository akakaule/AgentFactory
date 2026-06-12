/**
 * The `ai-review/v1` marker convention — the single source of truth for recognising,
 * parsing, and counting an external reviewer's findings. The board never runs the
 * reviewer; an external loop posts findings as a comment whose body begins with the
 * marker `ai-review/v1`, followed by a short human-readable summary and a fenced JSON
 * block: `{ reviewer, verdict, findings: [{ severity, file, line?, title, detail }] }`.
 * See docs/superpowers/specs/2026-06-12-ai-review-tier.md for the full contract.
 */
import type { AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity } from './types.js';
import type { ActivityStep } from './metrics.js';

/** A comment is an AI review iff its body (leading whitespace ignored) starts with this. */
const MARKER = /^ai-review\/v1\b/i;

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

const SEVERITIES: readonly string[] = ['info', 'warning', 'error'];

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
  return { severity, file, line, title, detail };
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
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.findings)) return null;
  const findings = obj.findings
    .map(normalizeFinding)
    .filter((f): f is AiReviewFinding => f !== null);
  const reviewer = typeof obj.reviewer === 'string' && obj.reviewer.trim() ? obj.reviewer.trim() : null;
  return { reviewer, findings };
}

/**
 * Build the chip/drawer verdict from a parsed review and a freshness flag.
 * `superseded` = a result activity newer than this review exists ⇒ the verdict reads
 * `pending` (a fresh re-review is due). Otherwise `clean` (0) or `findings` (N>0).
 */
export function summarizeAiReview(parsed: ParsedAiReview | null, superseded: boolean): AiReviewSummary | null {
  if (!parsed) return null;
  const findings = parsed.findings.length;
  const verdict: AiReviewVerdict = superseded ? 'pending' : findings > 0 ? 'findings' : 'clean';
  return { verdict, findings, reviewer: parsed.reviewer, items: parsed.findings };
}

/**
 * The findings count standing at a task's *final* approval, or null when the approved
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
      if (p) current = p.findings.length;
    } else if (s.type === 'result') {
      current = null; // a fresh result supersedes the prior review ⇒ pending until re-reviewed
    } else if (s.type === 'status_change' && s.toStatus === 'done') {
      atDone = current;
    }
  }
  return atDone;
}
