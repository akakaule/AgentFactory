/**
 * `failure-triage-evidence/v2` — turns a stored `failure/v1` note into the local text the triage
 * rules read; v2 unpacks agent stream logs (streamLineEvidence). Pure and deterministic so db and board mode derive identical labels. The stored note
 * is never rewritten; nothing here leaves the machine (Phase 2's outbound redaction is separate).
 */

export const FAILURE_TRIAGE_EVIDENCE_VERSION = 'failure-triage-evidence/v2';

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

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** The text of a Claude tool_result block: a string, or an array of `{ type: 'text', text }` parts. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : '')).filter((t) => t !== '').join('\n');
}

/**
 * One line of a worker's log, re-expressed as what the rules should read. Workers log as Claude
 * stream-json or Codex `exec --json`, where a tool's output is one JSON line with escaped newlines
 * and the agent's own words sit beside it. Tool and command output is unpacked into real lines;
 * the agent's narration, reasoning, and prompt are dropped (an agent describing an error is not
 * the error); a successful result keeps only its header (its text is narration) while an error
 * result is kept whole (the CLI reports its own failures there). Anything else — plain text,
 * malformed or cut JSON, other events — is kept as is.
 */
function streamLineEvidence(line: string): string {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return line;
  let event: unknown;
  try { event = JSON.parse(trimmed); } catch { return line; }
  if (!isRecord(event)) return line;
  switch (event.type) {
    case 'assistant':
      return '';
    case 'user': {
      const content = isRecord(event.message) ? event.message.content : undefined;
      if (!Array.isArray(content)) return '';
      return content.map((block) => (isRecord(block) && block.type === 'tool_result' ? toolResultText(block.content) : '')).filter((t) => t !== '').join('\n');
    }
    case 'result':
      return event.is_error === false ? JSON.stringify({ type: 'result', subtype: event.subtype, is_error: false }) : line;
    case 'item.started': case 'item.updated': case 'item.completed': {
      const item = isRecord(event.item) ? event.item : null;
      if (item?.type === 'agent_message' || item?.type === 'reasoning') return '';
      if (item?.type === 'command_execution') return typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
      return line;
    }
    default:
      return line;
  }
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
 * The text the rules scan: the note's one-line detail plus its evidence body (stream lines unpacked,
 * then normalized), bounded
 * to MAX_SCAN_CHARS by keeping head and tail with an explicit omission line.
 */
export function failureEvidenceText(body: string, detail: string | null): string {
  const lines = failureEvidenceBody(body).replace(/\r\n?/g, '\n').split('\n').map(streamLineEvidence);
  const evidence = normalizeFailureText(lines.join('\n')).trim();
  const text = [detail ? normalizeFailureText(detail).trim() : '', evidence].filter((part) => part !== '').join('\n');
  if (text.length <= MAX_SCAN_CHARS) return text;
  const half = MAX_SCAN_CHARS / 2;
  return `${text.slice(0, half)}\n[… ${text.length - MAX_SCAN_CHARS} characters omitted …]\n${text.slice(-half)}`;
}
