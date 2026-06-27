/**
 * Normalizing an agent CLI's raw session transcript (JSONL) into a flat list of renderable
 * blocks — the single source of truth for turning a `claude -p` (or, later, codex) transcript
 * into the user/assistant/thinking/bash/tool blocks the drawer shows. The dispatcher captures
 * the raw bytes (live tail + a persisted artifact); this module is the *read* path, parsed on
 * demand in ops/transcript.ts (mirrors how aiReview.ts / failure.ts derive from raw text).
 *
 * Claude Code writes one JSON object per line: metadata lines (`mode`, `permission-mode`,
 * `file-history-snapshot`, `ai-title`, injected `attachment` context) that carry no `message`,
 * then `user`/`assistant` turns whose `message.content` is either a bare string or an array of
 * content blocks (`text` / `thinking` / `tool_use`). A tool's result rides a *later* `user` line
 * as a `tool_result` block, with a richer `toolUseResult` sidecar (Bash stdout/stderr/exit). We
 * fold each `tool_use` together with its result into one block in two passes.
 *
 * Hard rules: never throw (a transcript is observability, not control flow — a malformed or
 * half-written line degrades, it never breaks a poll), truncate oversized fields, and redact
 * obvious secrets before a block leaves this module (the transcript now persists in the DB and
 * is served over the API — see redact()).
 */
import type { TranscriptBlock, TranscriptEngine } from './types.js';

/** Per-field caps. Transcripts reach multiple MB; a single file-read/diff field can be huge. */
const MAX_TEXT = 16_000;   // assistant/user prose + thinking
const MAX_OUTPUT = 8_000;  // bash stdout/stderr, tool result
const MAX_INPUT = 2_000;   // tool input JSON preview

interface RawLine {
  type?: unknown;
  isSidechain?: unknown;
  uuid?: unknown;
  timestamp?: unknown;
  message?: { role?: unknown; content?: unknown } | undefined;
  toolUseResult?: unknown;
}

/** A tool_use's folded result, collected in pass 1 keyed by tool_use_id. */
interface ToolResult { text: string; isError: boolean; sidecar: unknown; }

/** Truncate to head+tail with a marker; reports whether it cut. */
function clamp(s: string, max: number): { text: string; truncated: boolean } {
  if (s.length <= max) return { text: s, truncated: false };
  const head = s.slice(0, Math.floor(max * 0.7));
  const tail = s.slice(-Math.floor(max * 0.2));
  return { text: `${head}\n…[truncated ${s.length - head.length - tail.length} chars]…\n${tail}`, truncated: true };
}

const SECRET_PATTERNS: readonly [RegExp, string][] = [
  [/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer «redacted»'],
  [/\bgh[posru]_[A-Za-z0-9]{16,}/g, '«redacted-gh-token»'],
  [/\bsk-ant-[A-Za-z0-9_-]{12,}/g, '«redacted-key»'],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}/g, '«redacted-token»'],
  // KEY=value / KEY: value where the key name smells secret (tokens, OTLP headers, AF env)
  [/\b([A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|APIKEY|API_KEY|OTLP_HEADERS)[A-Za-z0-9_]*)\s*([=:])\s*\S+/gi, '$1$2«redacted»'],
];

/** Best-effort secret masking. Defence-in-depth: the worktree was already trusted; this keeps
 *  the persisted/served transcript from casually leaking the creds the dispatcher injects. */
function redact(s: string): string {
  let out = s;
  for (const [re, repl] of SECRET_PATTERNS) out = out.replace(re, repl);
  return out;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null);

/** Flatten a tool_result `content` (string | array of {text} | array of strings) into text. */
function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && typeof c === 'object' && 'text' in c ? str((c as { text: unknown }).text) : ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

/** Parse one JSON line; null on any malformed/blank line (tolerated, never thrown). */
function parseLine(line: string): RawLine | null {
  const t = line.trim();
  if (!t) return null;
  try {
    const o = JSON.parse(t) as unknown;
    return o && typeof o === 'object' ? (o as RawLine) : null;
  } catch {
    return null;
  }
}

/** Pass 1 — map every tool_use_id to its (later) result + Bash sidecar. */
function collectResults(lines: RawLine[]): Map<string, ToolResult> {
  const byId = new Map<string, ToolResult>();
  for (const line of lines) {
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (!block || typeof block !== 'object') continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result' || typeof b.tool_use_id !== 'string') continue;
      byId.set(b.tool_use_id, { text: resultText(b.content), isError: b.is_error === true, sidecar: line.toolUseResult });
    }
  }
  return byId;
}

function bashBlock(base: Omit<Extract<TranscriptBlock, { kind: 'bash' }>, 'kind' | 'command' | 'description' | 'stdout' | 'stderr' | 'exitCode' | 'isError' | 'truncated'>, input: Record<string, unknown>, res: ToolResult | undefined): TranscriptBlock {
  const cmd = clamp(redact(str(input.command)), MAX_OUTPUT);
  const sidecar = (res?.sidecar && typeof res.sidecar === 'object' ? res.sidecar : null) as Record<string, unknown> | null;
  const rawOut = sidecar && (typeof sidecar.stdout === 'string' || typeof sidecar.stderr === 'string') ? str(sidecar.stdout) : (res?.text ?? '');
  const out = clamp(redact(rawOut), MAX_OUTPUT);
  const err = clamp(redact(sidecar ? str(sidecar.stderr) : ''), MAX_OUTPUT);
  const desc = str(input.description);
  return {
    ...base, kind: 'bash',
    command: cmd.text,
    description: desc ? redact(desc) : null,
    stdout: out.text ? out.text : null,
    stderr: err.text ? err.text : null,
    exitCode: sidecar ? numOrNull(sidecar.exitCode ?? sidecar.exit_code ?? sidecar.code) : null,
    isError: res?.isError ?? false,
    truncated: cmd.truncated || out.truncated || err.truncated,
  };
}

function toolBlock(base: Omit<Extract<TranscriptBlock, { kind: 'tool' }>, 'kind' | 'name' | 'input' | 'result' | 'isError' | 'truncated'>, name: string, input: unknown, res: ToolResult | undefined): TranscriptBlock {
  const inp = clamp(redact(safeStringify(input)), MAX_INPUT);
  const result = res ? clamp(redact(res.text), MAX_OUTPUT) : null;
  return {
    ...base, kind: 'tool', name,
    input: inp.text,
    result: result && result.text ? result.text : null,
    isError: res?.isError ?? false,
    truncated: inp.truncated || (result?.truncated ?? false),
  };
}

function safeStringify(v: unknown): string {
  try {
    return typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/**
 * Parse a raw transcript into ordered, normalized blocks. `engine` selects the dialect; only
 * `claude` is implemented today (codex falls through to the same shape once added). Pure and
 * total: any input — empty, partial, or garbage — yields a (possibly empty) block list, never a throw.
 */
export function parseTranscript(raw: string, engine: TranscriptEngine = 'claude'): TranscriptBlock[] {
  void engine; // single dialect today; kept for the codex drop-in
  const lines = raw.split('\n').map(parseLine).filter((l): l is RawLine => l !== null);
  const results = collectResults(lines);
  const blocks: TranscriptBlock[] = [];

  for (const line of lines) {
    const rawRole = line.message?.role;
    const role: 'user' | 'assistant' | null = rawRole === 'user' ? 'user' : rawRole === 'assistant' ? 'assistant' : null;
    if (!role) continue; // metadata / attachment lines have no message
    const uuid = typeof line.uuid === 'string' ? line.uuid : 'x';
    const at = typeof line.timestamp === 'string' ? line.timestamp : null;
    const sidechain = line.isSidechain === true;
    const base = { role, at, sidechain };

    const content = line.message?.content;
    if (typeof content === 'string') {
      const text = content.trim();
      if (text) blocks.push({ ...base, id: `${uuid}:0`, kind: 'text', text: clamp(redact(text), MAX_TEXT).text });
      continue;
    }
    if (!Array.isArray(content)) continue;

    content.forEach((block, i) => {
      if (!block || typeof block !== 'object') return;
      const b = block as Record<string, unknown>;
      const id = `${uuid}:${i}`;
      switch (b.type) {
        case 'text': {
          const text = str(b.text).trim();
          if (text) blocks.push({ ...base, id, kind: 'text', text: clamp(redact(text), MAX_TEXT).text });
          return;
        }
        case 'thinking': {
          const text = str(b.thinking).trim();
          if (text) blocks.push({ ...base, id, kind: 'thinking', text: clamp(redact(text), MAX_TEXT).text });
          return;
        }
        case 'tool_use': {
          const name = str(b.name) || 'tool';
          const input = (b.input && typeof b.input === 'object' ? b.input : {}) as Record<string, unknown>;
          const res = typeof b.id === 'string' ? results.get(b.id) : undefined;
          blocks.push(name === 'Bash' ? bashBlock({ ...base, id }, input, res) : toolBlock({ ...base, id }, name, b.input, res));
          return;
        }
        case 'image':
          blocks.push({ ...base, id, kind: 'image', note: '[image]' });
          return;
        // tool_result is folded into its tool_use (pass 1); anything else is ignored defensively
        default:
          return;
      }
    });
  }
  return blocks;
}
