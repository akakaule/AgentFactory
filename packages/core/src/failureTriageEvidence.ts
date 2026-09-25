/**
 * `failure-triage-evidence/v1` — turns a stored `failure/v1` note into the local text the triage
 * rules read. Pure and deterministic so db and board mode derive identical labels. The stored note
 * is never rewritten; nothing here leaves the machine (Phase 2's outbound redaction is separate).
 */

export const FAILURE_TRIAGE_EVIDENCE_VERSION = 'failure-triage-evidence/v1';

/** Longest text the rules scan; longer evidence keeps its head and tail (errors cluster at both ends). */
const MAX_SCAN_CHARS = 64_000;

// CSI sequences (colors, cursor moves) and OSC sequences (titles, hyperlinks).
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
// C0 controls except tab and newline, plus DEL.
const CONTROL = /[\x00-\x08\x0b-\x1f\x7f]/g;

/** CRLF/CR → LF, ANSI escapes and other control characters removed; line boundaries preserved. */
export function normalizeFailureText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(ANSI, '').replace(CONTROL, '');
}

/**
 * The part of a failure note after its structured header: `buildFailureComment` writes a marker
 * line, then a fenced JSON block, then the optional free-form body (log tail, captured build
 * errors). The first fenced block is the header, matching `parseFailureComment`; everything after
 * it is evidence. Embedded Markdown is data, never instructions.
 */
export function failureEvidenceBody(body: string): string {
  const fence = body.match(/```(?:json)?\s*[\s\S]*?```/i);
  if (!fence || fence.index === undefined) return '';
  return body.slice(fence.index + fence[0].length);
}

/**
 * The text the rules scan: the note's one-line detail plus its normalized evidence body, bounded
 * to MAX_SCAN_CHARS by keeping head and tail with an explicit omission line.
 */
export function failureEvidenceText(body: string, detail: string | null): string {
  const evidence = normalizeFailureText(failureEvidenceBody(body)).trim();
  const text = [detail ? normalizeFailureText(detail).trim() : '', evidence].filter((part) => part !== '').join('\n');
  if (text.length <= MAX_SCAN_CHARS) return text;
  const half = MAX_SCAN_CHARS / 2;
  return `${text.slice(0, half)}\n[… ${text.length - MAX_SCAN_CHARS} characters omitted …]\n${text.slice(-half)}`;
}
