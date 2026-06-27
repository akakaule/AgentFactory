import type { DB } from '../db.js';
import type { TranscriptEngine, TranscriptResponse } from '../types.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { appendLiveBuf, saveFinal, getTranscriptRow, decodeRaw } from '../repo/transcripts.js';
import { parseTranscript } from '../transcript.js';
import { nowIso } from '../time.js';

/**
 * Standalone entry points for the agent transcript (the dispatcher tails into appendTranscript /
 * persists via saveTranscript; the web drawer reads getTranscript). They resolve a task key and
 * wrap the repo primitive in a transaction — mirroring ops/agentSession.ts. The write paths are
 * total: an unknown key is a silent no-op (a transcript is observability, never control flow).
 */

export interface AppendTranscriptInput { chunk: string; attempt?: number; sessionId?: string | null; engine?: TranscriptEngine; }
export interface SaveTranscriptInput { raw: string; attempt?: number; sessionId?: string | null; engine?: TranscriptEngine; }

/** Append a chunk of the running session's raw JSONL to a task's live transcript tail. */
export function appendTranscript(db: DB, key: string, input: AppendTranscriptInput, now: () => string = nowIso): void {
  const row = findRowByKey(db, key);
  if (!row) return;
  transaction(db, () =>
    appendLiveBuf(db, {
      taskId: row.id, attempt: input.attempt ?? 1, sessionId: input.sessionId ?? null,
      engine: input.engine ?? 'claude', chunk: input.chunk, now: now(),
    }),
  );
}

/** Persist the full transcript for a task's attempt at session exit (gzip + flip to 'final'). */
export function saveTranscript(db: DB, key: string, input: SaveTranscriptInput, now: () => string = nowIso): void {
  const row = findRowByKey(db, key);
  if (!row) return;
  transaction(db, () =>
    saveFinal(db, {
      taskId: row.id, attempt: input.attempt ?? 1, sessionId: input.sessionId ?? null,
      engine: input.engine ?? 'claude', raw: input.raw, now: now(),
    }),
  );
}

/** The task's transcript as normalized blocks — live tail while running, persisted artifact after.
 *  state:'none' when nothing was captured (or the task is gone) so the drawer hides the section. */
export function getTranscript(db: DB, key: string): TranscriptResponse {
  const none: TranscriptResponse = { state: 'none', engine: null, attempt: null, bytes: null, blocks: [] };
  const task = findRowByKey(db, key);
  if (!task) return none;
  const row = getTranscriptRow(db, task.id);
  if (!row) return none;
  const engine: TranscriptEngine = row.engine === 'codex' ? 'codex' : 'claude';
  return { state: row.state, engine, attempt: row.attempt, bytes: row.bytes, blocks: parseTranscript(decodeRaw(row), engine) };
}
