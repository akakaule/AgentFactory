import { gzipSync, gunzipSync } from 'node:zlib';
import type { DB } from '../db.js';
import type { ReviewRevision } from '../types.js';

/**
 * Repo primitives for the `task_visualization` table (migration #16). The gzip codec lives here so
 * the `format` column stays honest. These run INSIDE a caller's transaction (ops/visualization.ts) —
 * they never open their own. None touch task.updated_at; getVersion() folds the table's own
 * updated_at instead (an attach is a once-per-review event, so a version bump there is fine).
 *
 * One row per task: re-attaching replaces the stored HTML (latest overview wins).
 */

export interface VisualizationMeta {
  generatedAt: string; // when the HTML was authored/attached
  bytes: number;       // uncompressed HTML size
  revision?: ReviewRevision | null; // the submission it was attached under (migration #29); null when unbound
}

export interface SaveVisualizationInput { taskId: number; html: string; now: string; revision?: ReviewRevision | null; }

/** Store (or replace) a task's visualization HTML, gzipped. Idempotent upsert keyed by task_id. */
export function saveVisualization(db: DB, p: SaveVisualizationInput): void {
  const gz = gzipSync(Buffer.from(p.html, 'utf8'));
  const exists = db.prepare('SELECT 1 FROM task_visualization WHERE task_id = ?').get(p.taskId);
  const submissionId = p.revision?.submissionId ?? null;
  const headSha = p.revision?.headSha ?? null;
  if (exists) {
    db.prepare(
      `UPDATE task_visualization SET html_gz = ?, bytes = ?, format = 'html-gz', generated_at = ?, updated_at = ?, submission_id = ?, head_sha = ?
         WHERE task_id = ?`,
    ).run(gz, p.html.length, p.now, p.now, submissionId, headSha, p.taskId);
  } else {
    db.prepare(
      `INSERT INTO task_visualization(task_id, format, html_gz, bytes, generated_at, updated_at, submission_id, head_sha)
       VALUES (?, 'html-gz', ?, ?, ?, ?, ?, ?)`,
    ).run(p.taskId, gz, p.html.length, p.now, p.now, submissionId, headSha);
  }
}

/** Presence + lightweight meta for a task's visualization (or null when none was attached). */
export function visualizationMetaFor(db: DB, taskId: number): VisualizationMeta | null {
  const row = db.prepare('SELECT generated_at, bytes, submission_id, head_sha FROM task_visualization WHERE task_id = ?')
    .get(taskId) as { generated_at: string; bytes: number; submission_id: number | null; head_sha: string | null } | undefined;
  if (!row) return null;
  return { generatedAt: row.generated_at, bytes: row.bytes, revision: row.submission_id === null ? null : { submissionId: row.submission_id, headSha: row.head_sha } };
}

/** The stored HTML, gunzipped — or null when none exists or the blob is corrupt (it's a view, not
 *  control flow, so a decode failure degrades to null rather than throwing). */
export function getVisualizationHtml(db: DB, taskId: number): string | null {
  const row = db.prepare('SELECT html_gz FROM task_visualization WHERE task_id = ?')
    .get(taskId) as { html_gz: Uint8Array | null } | undefined;
  if (!row || !row.html_gz) return null;
  try {
    return gunzipSync(Buffer.from(row.html_gz)).toString('utf8');
  } catch {
    return null;
  }
}
