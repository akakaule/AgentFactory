/**
 * Measured usage parsed from a `claude -p --output-format json` result envelope.
 * Every field is optional — the parser is best-effort and tolerant of shape drift
 * across CLI versions; only what it could read is returned.
 */
export interface ParsedMetrics {
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number;
  durationMs?: number;
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/** Sum the input-side token fields that are present (plain + cache create + cache read). */
function sumInputTokens(usage: Record<string, unknown>): number | undefined {
  const parts = [usage['input_tokens'], usage['cache_creation_input_tokens'], usage['cache_read_input_tokens']]
    .map(asNumber)
    .filter((n): n is number => n !== undefined);
  return parts.length > 0 ? parts.reduce((a, b) => a + b, 0) : undefined;
}

/** Pull the model id from a top-level `model` field or the first key of `modelUsage`. */
function readModel(obj: Record<string, unknown>): string | undefined {
  const top = obj['model'];
  if (typeof top === 'string' && top.length > 0) return top;
  const mu = obj['modelUsage'];
  if (mu && typeof mu === 'object') {
    const keys = Object.keys(mu as Record<string, unknown>);
    if (keys.length > 0) return keys[0];
  }
  return undefined;
}

/** Find the result JSON in stdout: whole-string parse, else the outermost `{...}`, else a JSON line. */
function extractJson(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const tryParse = (s: string): Record<string, unknown> | null => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  };
  const whole = tryParse(trimmed);
  if (whole) return whole;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const span = tryParse(trimmed.slice(start, end + 1));
    if (span) return span;
  }
  for (const line of trimmed.split(/\r?\n/).reverse()) {
    const l = line.trim();
    if (l.startsWith('{') && l.endsWith('}')) {
      const parsed = tryParse(l);
      if (parsed) return parsed;
    }
  }
  return null;
}

/**
 * Parse the CLI's JSON result into measured metrics. Returns `{}` when nothing usable
 * is found, so callers can record only the fields that were actually measured.
 */
export function parseCliMetrics(stdout: string): ParsedMetrics {
  const obj = extractJson(stdout);
  if (!obj) return {};
  const out: ParsedMetrics = {};

  const model = readModel(obj);
  if (model !== undefined) out.model = model;

  const usage = obj['usage'];
  if (usage && typeof usage === 'object') {
    const u = usage as Record<string, unknown>;
    const tokensIn = sumInputTokens(u);
    if (tokensIn !== undefined) out.tokensIn = tokensIn;
    const tokensOut = asNumber(u['output_tokens']);
    if (tokensOut !== undefined) out.tokensOut = tokensOut;
  }

  const cost = asNumber(obj['total_cost_usd']) ?? asNumber(obj['cost_usd']);
  if (cost !== undefined) out.costUsd = cost;

  const duration = asNumber(obj['duration_ms']);
  if (duration !== undefined) out.durationMs = duration;

  return out;
}

/** True when the metrics carry at least one value worth recording. */
export function hasMetrics(m: ParsedMetrics): boolean {
  return m.model !== undefined || m.tokensIn !== undefined || m.tokensOut !== undefined || m.costUsd !== undefined;
}
