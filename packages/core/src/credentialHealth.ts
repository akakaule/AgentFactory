/**
 * Workspace git-credential health (app_kv 'credential_health', JSON keyed by workspace; no
 * migration, outside getVersion()). The board's credential monitor probes each workspace's managed
 * credential (resolveGitAuth) and records the result here. A `failing` credential raises the board
 * banner and holds queued implementation work in that workspace (claimNextTask) until a check
 * passes again or the PAT is replaced.
 */
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';
import { nowIso } from './time.js';

const KV_KEY = 'credential_health';
/** A credential this close to its expiry reads `expiring`. */
export const EXPIRY_WARN_DAYS = 7;
const MAX_ERROR = 300;

export type CredentialStatus = 'ok' | 'failing' | 'unreachable';
export type CredentialState = CredentialStatus | 'expiring';

/** One probe's outcome. `unreachable` = the host could not be asked (network, timeout) — never a verdict on the credential. */
export interface CredentialCheck { status: CredentialStatus; error: string | null; expiresAt: string | null; }
export interface CredentialRecord extends CredentialCheck {
  checkedAt: string;
  failingSince: string | null; // first failing check of the current failure run
}
export interface CredentialHealthView {
  workspace: string;
  state: CredentialState;
  status: CredentialStatus;
  checkedAt: string;
  failingSince: string | null;
  error: string | null;
  expiresAt: string | null;
  expiresInDays: number | null;
}

type Doc = Record<string, CredentialRecord>;

function readDoc(db: DB): Doc {
  const raw = getKv(db, KV_KEY);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Doc : {};
  } catch { return {}; }
}

export function getCredentialRecord(db: DB, workspace: string): CredentialRecord | null {
  return readDoc(db)[workspace] ?? null;
}

/**
 * Record a probe result. A failure run keeps its first `failingSince`; an `unreachable` check cannot
 * prove a failing credential fixed, so it keeps the failure (with the new error) rather than lifting it.
 */
export function recordCredentialCheck(db: DB, workspace: string, check: CredentialCheck, now: () => string = nowIso): CredentialRecord {
  const doc = readDoc(db);
  const prev = doc[workspace];
  const ts = now();
  const error = check.error === null ? null : check.error.slice(0, MAX_ERROR);
  const keepFailure = check.status === 'unreachable' && prev?.status === 'failing';
  const status: CredentialStatus = keepFailure ? 'failing' : check.status;
  const record: CredentialRecord = {
    status, error, expiresAt: check.expiresAt, checkedAt: ts,
    failingSince: status === 'failing' ? (prev?.status === 'failing' ? prev.failingSince ?? ts : ts) : null,
  };
  doc[workspace] = record;
  setKv(db, KV_KEY, JSON.stringify(doc));
  return record;
}

/** Forget a workspace's record — its PAT changed, so the old verdict no longer applies. */
export function clearCredentialHealth(db: DB, workspace: string): void {
  const doc = readDoc(db);
  if (!(workspace in doc)) return;
  delete doc[workspace];
  setKv(db, KV_KEY, JSON.stringify(doc));
}

/** Recorded health of every existing workspace, with the derived state (`expiring` within EXPIRY_WARN_DAYS). */
export function listCredentialHealth(db: DB, now: () => string = nowIso): CredentialHealthView[] {
  const names = new Set((db.prepare('SELECT name FROM workspace').all() as Array<{ name: string }>).map((r) => r.name));
  const nowMs = Date.parse(now());
  return Object.entries(readDoc(db))
    .filter(([workspace]) => names.has(workspace))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([workspace, r]) => {
      const expiresInDays = r.expiresAt ? Math.max(0, Math.ceil((Date.parse(r.expiresAt) - nowMs) / 86_400_000)) : null;
      const state: CredentialState = r.status === 'ok' && expiresInDays !== null && expiresInDays < EXPIRY_WARN_DAYS ? 'expiring' : r.status;
      return { workspace, state, status: r.status, checkedAt: r.checkedAt, failingSince: r.failingSince, error: r.error, expiresAt: r.expiresAt, expiresInDays };
    });
}

/** Names of the workspaces whose credential is currently failing — their implementation work is held. */
export function failingCredentialWorkspaces(db: DB): Set<string> {
  return new Set(Object.entries(readDoc(db)).filter(([, r]) => r.status === 'failing').map(([w]) => w));
}
