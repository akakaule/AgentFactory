import type { DB } from '../db.js';
import type { VisualizationMeta } from '../repo/visualizations.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { saveVisualization, visualizationMetaFor, getVisualizationHtml as readVisualizationHtml } from '../repo/visualizations.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

/**
 * Standalone entry points for the per-task change visualization (the `/visualize-task` command
 * attaches via the web POST; the drawer reads getVisualizationHtml). They resolve a task key and
 * wrap the repo primitive in a transaction — mirroring ops/transcript.ts. Unlike the transcript
 * tail, attach is an explicit human-driven action, so an unknown key throws (the POST 404s) rather
 * than silently no-op'ing.
 */

export interface AttachVisualizationInput { html: string; }

/** Store (or replace) a task's change-visualization HTML. Throws NotFoundError for an unknown key. */
export function attachVisualization(db: DB, key: string, input: AttachVisualizationInput, now: () => string = nowIso): VisualizationMeta {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task ${key} not found`);
  const ts = now();
  transaction(db, () => saveVisualization(db, { taskId: row.id, html: input.html, now: ts }));
  return { generatedAt: ts, bytes: input.html.length };
}

/** Presence + meta for a task's visualization, or null when the task/visualization is absent. */
export function getVisualization(db: DB, key: string): VisualizationMeta | null {
  const row = findRowByKey(db, key);
  if (!row) return null;
  return visualizationMetaFor(db, row.id);
}

/** The task's stored visualization HTML, or null when the task/visualization is absent. */
export function getVisualizationHtml(db: DB, key: string): string | null {
  const row = findRowByKey(db, key);
  if (!row) return null;
  return readVisualizationHtml(db, row.id);
}
