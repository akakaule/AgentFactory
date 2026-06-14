/** Shared formatters for the live-agent surfaces (fleet view + drawer panel). */

/** Compact elapsed since an ISO timestamp, relative to `now` (ms). */
export function elapsed(fromIso: string, now: number): string {
  const s = Math.max(0, Math.floor((now - new Date(fromIso).getTime()) / 1000));
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

/** A heartbeat within this window counts as "live"; older reads as "quiet". */
export const ALIVE_MS = 90_000;

/** "41k" / "920" / "–" for nullable token counts. */
export function fmtTokens(n: number | null): string {
  if (n == null) return '–';
  return n >= 1000 ? `${Math.round(n / 100) / 10}k` : String(n);
}
