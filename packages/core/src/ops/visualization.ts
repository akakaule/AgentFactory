import type { DB } from '../db.js';
import type { VisualizationMeta } from '../repo/visualizations.js';
import { transaction } from '../transaction.js';
import { findRowByKey } from '../repo/tasks.js';
import { saveVisualization, visualizationMetaFor, getVisualizationHtml as readVisualizationHtml } from '../repo/visualizations.js';
import { InvalidTransitionError, NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';
import { assertExecutionOwnership } from '../repo/execution.js';
import { isCurrentSubmission, latestSubmissionFor, submissionById } from '../repo/submissions.js';

/**
 * Standalone entry points for the per-task change visualization (the `/visualize-task` command
 * attaches via the web POST; the drawer reads getVisualizationHtml). They resolve a task key and
 * wrap the repo primitive in a transaction — mirroring ops/transcript.ts. Unlike the transcript
 * tail, attach is an explicit human-driven action, so an unknown key throws (the POST 404s) rather
 * than silently no-op'ing.
 */

export interface AttachVisualizationInput {
  html: string;
  executionId?: string | undefined;
  /** The submission the producer visualized and the head its diff actually showed (a fallback live
   *  diff may show a later head than the submitted one). Omitted: the current submission's head. */
  revision?: { submissionId: number; headSha: string | null } | undefined;
}

/** Store (or replace) a task's change-visualization HTML. Throws NotFoundError for an unknown key. */
export function attachVisualization(db: DB, key: string, input: AttachVisualizationInput, now: () => string = nowIso): VisualizationMeta {
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task ${key} not found`);
    assertExecutionOwnership(db, row.id, key, input.executionId, { requireRunning: true });
    const ts = now();
    // stamp the revision the overview depicts: what the producer says it diffed — refused once that
    // submission was replaced — else the submission under review at its submitted head
    let revision: { submissionId: number; headSha: string | null } | null;
    if (input.revision) {
      const named = submissionById(db, input.revision.submissionId);
      if (!named || !isCurrentSubmission(db, row, named))
        throw new InvalidTransitionError(`visualization names submission #${input.revision.submissionId}, which is not the current submission of ${key}`);
      revision = { submissionId: named.id, headSha: input.revision.headSha };
    } else {
      const sub = latestSubmissionFor(db, row.id, row.stage);
      revision = sub ? { submissionId: sub.id, headSha: sub.head_sha } : null;
    }
    saveVisualization(db, { taskId: row.id, html: input.html, now: ts, revision });
    return { generatedAt: ts, bytes: input.html.length, revision };
  });
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
