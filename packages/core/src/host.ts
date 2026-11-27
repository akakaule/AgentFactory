import os from 'node:os';

/** Longest host label the board stores. Display-only metadata, so anything longer is cut. */
export const MAX_HOST_LENGTH = 64;

/**
 * Normalize a host label for display: keep `[A-Za-z0-9._-]`, cap the length, and return null when
 * nothing is left. A host is reported by whichever process runs the agent and is never trusted, so
 * the board sanitizes it before storing. Nothing outside that charset can reach the UI.
 */
export function sanitizeHost(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const clean = raw.replace(/[^A-Za-z0-9._-]/g, '').slice(0, MAX_HOST_LENGTH);
  return clean === '' ? null : clean;
}

/**
 * The host this process runs on, as the board should show it: `AGENTFACTORY_HOST` when set (a
 * friendly name, which the dispatcher also hands its workers so their sessions match its own
 * chip), else the OS hostname. Sanitized; null when neither yields anything.
 */
export function resolveHost(
  env: Record<string, string | undefined> = process.env,
  hostname: () => string = os.hostname,
): string | null {
  return sanitizeHost(env['AGENTFACTORY_HOST']?.trim() || hostname());
}
