/**
 * Failure-triage human operations (spec §7): exact source reads, cursor-paginated history, and
 * append-only confirm/correct feedback. Advisory only — nothing here touches status, claims,
 * retry budgets, or task `updated_at`; the feedback activity row alone moves getVersion().
 */
import { z } from 'zod';
import type { DB } from '../db.js';
import type { Activity, FailureTriageCategory, FailureTriageFeedback, FailureTriageFeedbackInput, FailureTriageHistoryItem, FailureTriageHistoryPage, TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { parse } from '../validate.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../errors.js';
import { findRowByKey, toDetail, feedbackFromActivity } from '../repo/tasks.js';
import { activityOfTask, appendActivity, failureClearedBetween, failureNotesDesc, failureTriageFeedbackActivities, type FailureNoteRow } from '../repo/activity.js';
import { isFailureMarker, parseFailureComment, type ParsedFailure } from '../failure.js';
import {
  FAILURE_TRIAGE_CATEGORIES, FAILURE_TRIAGE_NOTE_MAX, buildFailureTriageFeedbackComment, classifyFailureNote, summarizeFailureTriage,
  type FailureTriageClassification,
} from '../failureTriage.js';
import { nowIso } from '../time.js';

const HISTORY_DEFAULT_LIMIT = 20;
const HISTORY_MAX_LIMIT = 100;

function requireTask(db: DB, key: string) {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return row;
}

/**
 * Classify one failure note of a task with its episode context: `previous` is the failure note just
 * before it, in the same episode unless progress (result / ai-review / restart) landed in between.
 * For the current failure this is the same answer the task projection derives.
 */
function classifyNote(db: DB, taskId: number, note: FailureNoteRow, previous: FailureNoteRow | null): { parsed: ParsedFailure; classification: FailureTriageClassification } | null {
  const parsed = parseFailureComment(note.body);
  if (!parsed) return null; // a malformed failure note is inert — never a triage source
  const previousInEpisode = previous !== null && !failureClearedBetween(db, taskId, previous.id, note.id);
  return { parsed, classification: classifyFailureNote(note, parsed, previous, previousInEpisode) };
}

function feedbackFor(db: DB, taskId: number): FailureTriageFeedback[] {
  return (failureTriageFeedbackActivities(db, [taskId]).get(taskId) ?? [])
    .map(feedbackFromActivity)
    .filter((f): f is FailureTriageFeedback => f !== null);
}

/** The exact stored failure note (current or evidence event), even past the recent-activity window. */
export function getFailureTriageSource(db: DB, key: string, activityId: number): Activity {
  const row = requireTask(db, key);
  const activity = activityOfTask(db, row.id, activityId);
  if (!activity || activity.type !== 'comment' || !isFailureMarker(activity.body)) {
    throw new NotFoundError(`failure note ${activityId} not found on ${key}`);
  }
  return activity;
}

/** A task's failure events newest first, each with its rule result and the feedback bound to it. */
export function failureTriageHistory(db: DB, key: string, opts: { beforeId?: number | undefined; limit?: number | undefined } = {}): FailureTriageHistoryPage {
  const row = requireTask(db, key);
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? HISTORY_DEFAULT_LIMIT), 1), HISTORY_MAX_LIMIT);
  const notes = failureNotesDesc(db, row.id, opts.beforeId ?? null, limit + 1); // +1: the last item's predecessor, and "more?"
  const page = notes.slice(0, limit);
  const feedback = feedbackFor(db, row.id);
  const items: FailureTriageHistoryItem[] = [];
  page.forEach((note, i) => {
    const classified = classifyNote(db, row.id, note, notes[i + 1] ?? null);
    if (!classified) return;
    items.push({
      sourceActivityId: note.id, reason: classified.parsed.reason, source: classified.parsed.source, at: note.createdAt,
      evidenceActivityId: classified.classification.evidenceActivityId, rules: classified.classification.rules,
      feedback: feedback.filter((f) => f.sourceActivityId === note.id),
    });
  });
  return { items, nextBeforeId: notes.length > limit ? page[page.length - 1]!.id : null };
}

const category = z.enum(FAILURE_TRIAGE_CATEGORIES as unknown as [FailureTriageCategory, ...FailureTriageCategory[]]);
const feedbackSchema = z.object({
  sourceActivityId: z.number().int().positive(),
  action: z.enum(['confirm', 'correct']),
  shownCategory: category,
  category: category.optional(),
  note: z.string().optional(),
});

/**
 * Append a human confirm/correct for one failure event. The label the human saw (`shownCategory`)
 * must still be the label for that event, so a stale drawer cannot confirm something else; a newer
 * failure never inherits it (feedback binds the exact source activity id).
 */
export function recordFailureTriageFeedback(
  db: DB, key: string, input: FailureTriageFeedbackInput & { actorUserId?: number | null }, now: () => string = nowIso,
): TaskDetail {
  const b = parse(feedbackSchema, input);
  const note = b.note?.trim() || null;
  if (note !== null && note.length > FAILURE_TRIAGE_NOTE_MAX) throw new ValidationError(`note must be at most ${FAILURE_TRIAGE_NOTE_MAX} characters`);
  if (b.action === 'correct' && b.category === undefined) throw new ValidationError('a correction needs a category');
  return transaction(db, () => {
    const row = requireTask(db, key);
    const [source, previous] = failureNotesDesc(db, row.id, b.sourceActivityId + 1, 2);
    const classified = source && source.id === b.sourceActivityId ? classifyNote(db, row.id, source, previous ?? null) : null;
    if (!classified) throw new NotFoundError(`failure note ${b.sourceActivityId} not found on ${key}`);
    const human = feedbackFor(db, row.id).find((f) => f.sourceActivityId === b.sourceActivityId) ?? null;
    const shown = summarizeFailureTriage(b.sourceActivityId, classified.classification, human);
    if (shown.category !== b.shownCategory) throw new InvalidTransitionError('the failure triage label changed; refresh and try again');
    appendActivity(db, {
      taskId: row.id, type: 'comment', actor: 'human', actorUserId: input.actorUserId ?? null, createdAt: now(),
      body: buildFailureTriageFeedbackComment({
        sourceActivityId: b.sourceActivityId, action: b.action,
        category: b.action === 'confirm' ? shown.category : b.category!,
        shownCategory: shown.category, classifier: shown.classifier, rulesVersion: shown.rules.version, note,
      }),
    });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
