/**
 * The `curation/v1` marker convention — the single source of truth for recording and
 * parsing the human's per-finding disposition of an AI review. When a human requests
 * changes (curating which reviewer findings to forward vs. dismiss) or approves past
 * open findings (overriding them), the board persists a comment whose body begins with
 * the marker `curation/v1`, followed by a one-line human summary and a fenced JSON block:
 * `{ reviewer, dispositions: [{ severity, file, line, title, disposition }] }`.
 * Mirrors the `ai-review/v1` (aiReview.ts) and `failure/v1` (failure.ts) conventions.
 *
 * This captures the judgment signal the curation firewall already generates — the
 * reviewer-precision KPI derives from these comments (analyticsRows). Like ai-review
 * findings, curation dispositions are stripped from the agent's MCP payload: the human's
 * uncurated verdict on a finding must never steer the implementing agent.
 */
import type { CurationDisposition, CurationEntry, AiReviewSeverity } from './types.js';

/** A comment is a curation ledger iff its body (leading whitespace ignored) starts with this. */
const MARKER = /^curation\/v1\b/i;

const DISPOSITIONS: readonly string[] = ['forwarded', 'dismissed', 'overridden'];
const SEVERITIES: readonly string[] = ['info', 'warning', 'error'];

/** True iff a comment body carries the `curation/v1` marker (regardless of JSON well-formedness). */
export function isCurationMarker(body: string): boolean {
  return MARKER.test(body.trimStart());
}

export interface ParsedCuration {
  reviewer: string | null;
  dispositions: CurationEntry[];
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

function normalizeEntry(raw: unknown): CurationEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const title = typeof o.title === 'string' ? o.title.trim() : '';
  if (!title) return null; // a titleless disposition can't be attributed — drop it
  if (typeof o.disposition !== 'string' || !DISPOSITIONS.includes(o.disposition)) return null;
  const disposition = o.disposition as CurationDisposition;
  const severity: AiReviewSeverity | null =
    typeof o.severity === 'string' && SEVERITIES.includes(o.severity) ? (o.severity as AiReviewSeverity) : null;
  const file = typeof o.file === 'string' && o.file.trim() ? o.file.trim() : null;
  const line = typeof o.line === 'number' && Number.isFinite(o.line) ? Math.trunc(o.line) : null;
  return { severity, file, line, title, disposition };
}

/**
 * Parse a comment body into a structured curation ledger, or null when the body carries no
 * marker OR the embedded JSON is malformed / lacks a non-empty `dispositions` array. A
 * malformed marker comment degrades to a plain comment (no ledger) — same contract as
 * parseAiReviewComment; it is still hidden from the agent (see `isCurationMarker`).
 */
export function parseCurationComment(body: string): ParsedCuration | null {
  if (!isCurationMarker(body)) return null;
  const json = extractJson(body);
  if (!json || typeof json !== 'object') return null;
  const obj = json as Record<string, unknown>;
  if (!Array.isArray(obj.dispositions)) return null;
  const dispositions = obj.dispositions
    .map(normalizeEntry)
    .filter((e): e is CurationEntry => e !== null);
  if (dispositions.length === 0) return null;
  const reviewer = typeof obj.reviewer === 'string' && obj.reviewer.trim() ? obj.reviewer.trim() : null;
  return { reviewer, dispositions };
}

/** `2 forwarded, 1 dismissed` — the non-zero disposition counts, for the head summary line. */
function summarize(dispositions: CurationEntry[]): string {
  const counts: Record<CurationDisposition, number> = { forwarded: 0, dismissed: 0, overridden: 0 };
  for (const d of dispositions) counts[d.disposition] += 1;
  const parts = (['forwarded', 'dismissed', 'overridden'] as const)
    .filter((k) => counts[k] > 0)
    .map((k) => `${counts[k]} ${k}`);
  return parts.join(', ') || 'no findings';
}

/**
 * Compose a `curation/v1` comment body: the marker + human summary on line 1 (so it reads
 * fine in the activity timeline), then the machine-readable JSON. Callers build it in exactly
 * one place so the on-disk format lives here. Reviewer is the engine that raised the findings.
 */
export function buildCurationComment(reviewer: string | null, dispositions: CurationEntry[]): string {
  const json = JSON.stringify({ reviewer, dispositions });
  const who = reviewer ? ` (${reviewer})` : '';
  const head = `curation/v1 — ${summarize(dispositions)}${who}`;
  return `${head}\n\n\`\`\`json\n${json}\n\`\`\``;
}
