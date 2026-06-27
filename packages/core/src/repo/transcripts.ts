import { gzipSync, gunzipSync } from 'node:zlib';
import type { DB } from '../db.js';
import type { TranscriptEngine } from '../types.js';

/**
 * Repo primitives for the `task_transcript` table (migration #15). The gzip codec lives here so
 * the `format` column stays honest. These run INSIDE a caller's transaction (ops/transcript.ts) —
 * they never open their own. None touch task.updated_at, so getVersion() is unaffected.
 *
 * Lifecycle: the dispatcher tails the running session and calls appendLiveBuf() (capped rolling
 * `live_buf`, state 'live'); at exit it calls saveFinal() once with the whole transcript (gzipped
 * into `raw_gz`, `live_buf` cleared, state 'final'). A finalized row is never reopened by a late tail.
 */

// Rolling live-tail cap — keeps the live row bounded while the session streams (~256 KB of JSONL).
const LIVE_CAP = 256 * 1024;

export interface TranscriptRow {
  attempt: number;
  session_id: string | null;
  engine: string;
  format: string;
  raw_gz: Uint8Array | null;
  live_buf: string | null;
  bytes: number | null;
  state: 'live' | 'final';
}

export interface AppendLiveInput { taskId: number; attempt: number; sessionId: string | null; engine: TranscriptEngine; chunk: string; now: string; }
export interface SaveFinalInput { taskId: number; attempt: number; sessionId: string | null; engine: TranscriptEngine; raw: string; now: string; }

/** Append a chunk of raw JSONL to a task's live tail (creating the row on first sight). No-op
 *  on an already-finalized attempt (the persisted artifact supersedes any straggling tail). */
export function appendLiveBuf(db: DB, p: AppendLiveInput): void {
  const row = db.prepare('SELECT live_buf, bytes, state FROM task_transcript WHERE task_id = ? AND attempt = ?')
    .get(p.taskId, p.attempt) as { live_buf: string | null; bytes: number | null; state: string } | undefined;
  if (!row) {
    const buf = p.chunk.length > LIVE_CAP ? p.chunk.slice(-LIVE_CAP) : p.chunk;
    db.prepare(
      `INSERT INTO task_transcript(task_id, attempt, session_id, engine, format, live_buf, bytes, state, started_at, updated_at)
       VALUES (?,?,?,?,?,?,?,'live',?,?)`,
    ).run(p.taskId, p.attempt, p.sessionId, p.engine, 'claude-jsonl-gz', buf, p.chunk.length, p.now, p.now);
    return;
  }
  if (row.state !== 'live') return; // finalized — leave the persisted transcript alone
  const combined = (row.live_buf ?? '') + p.chunk;
  const buf = combined.length > LIVE_CAP ? combined.slice(-LIVE_CAP) : combined;
  db.prepare(
    `UPDATE task_transcript SET live_buf = ?, bytes = ?, session_id = COALESCE(session_id, ?), updated_at = ?
       WHERE task_id = ? AND attempt = ? AND state = 'live'`,
  ).run(buf, (row.bytes ?? 0) + p.chunk.length, p.sessionId, p.now, p.taskId, p.attempt);
}

/** Persist the full transcript for an attempt (gzipped), flip it to 'final', and drop the live
 *  tail. Idempotent over re-saves; upserts so it works whether or not a live row was ever written. */
export function saveFinal(db: DB, p: SaveFinalInput): void {
  const gz = gzipSync(Buffer.from(p.raw, 'utf8'));
  const exists = db.prepare('SELECT 1 FROM task_transcript WHERE task_id = ? AND attempt = ?').get(p.taskId, p.attempt);
  if (exists) {
    db.prepare(
      `UPDATE task_transcript SET raw_gz = ?, bytes = ?, live_buf = NULL, state = 'final',
           session_id = COALESCE(session_id, ?), engine = ?, updated_at = ?
         WHERE task_id = ? AND attempt = ?`,
    ).run(gz, p.raw.length, p.sessionId, p.engine, p.now, p.taskId, p.attempt);
  } else {
    db.prepare(
      `INSERT INTO task_transcript(task_id, attempt, session_id, engine, format, raw_gz, bytes, state, started_at, updated_at)
       VALUES (?,?,?,?,?,?,?, 'final', ?, ?)`,
    ).run(p.taskId, p.attempt, p.sessionId, p.engine, 'claude-jsonl-gz', gz, p.raw.length, p.now, p.now);
  }
}

/** The latest attempt's transcript row for a task, or undefined when none was ever captured. */
export function getTranscriptRow(db: DB, taskId: number): TranscriptRow | undefined {
  return db.prepare(
    'SELECT attempt, session_id, engine, format, raw_gz, live_buf, bytes, state FROM task_transcript WHERE task_id = ? ORDER BY attempt DESC LIMIT 1',
  ).get(taskId) as TranscriptRow | undefined;
}

/** Decode a row back to raw JSONL text: gunzip the persisted artifact, or the live tail as-is.
 *  Total — a corrupt gzip degrades to '' rather than throwing (observability, not control flow). */
export function decodeRaw(row: TranscriptRow): string {
  if (row.state === 'final' && row.raw_gz) {
    try {
      return gunzipSync(Buffer.from(row.raw_gz)).toString('utf8');
    } catch {
      return '';
    }
  }
  return row.live_buf ?? '';
}
