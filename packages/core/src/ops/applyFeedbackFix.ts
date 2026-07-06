import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { transaction } from '../transaction.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { parsePrFeedbackComment, parseFeedbackEvalComment, type ParsedPrFeedback, type ParsedFeedbackEval } from '../prFeedback.js';
import { nowIso } from '../time.js';

/** Compose the human-endorsed feedback the reclaimed worker acts on (the raw AI verdict is stripped
 *  from the claim; this composed `feedback` activity is not). */
function composeFixFeedback(fb: ParsedPrFeedback, ev: ParsedFeedbackEval | null): string {
  const lines = [
    'A human forwarded PR-review feedback on your already-delivered branch and asked you to address it.',
    '',
    'PR REVIEW COMMENT:',
    fb.feedback,
  ];
  if (ev) {
    lines.push('', `EVALUATION (${ev.disposition}): ${ev.reasoning}`);
    if (ev.suggestedChange) lines.push('', 'SUGGESTED CHANGE:', ev.suggestedChange);
  }
  lines.push(
    '',
    'Critically assess this yourself: if it identifies a real issue, fix it on the SAME branch and push (the PR updates). If it is not warranted or is out of scope, make NO code change and explain your reasoning in submit_result.',
  );
  return lines.join('\n');
}

/**
 * Pull a DELIVERING task back to `queued` to apply forwarded PR-review feedback (the human clicked
 * "Apply fix" on a warranted verdict). Mirrors failDelivery's atomic shape: one transaction, a
 * composed `feedback` activity (PR comment + the evaluator's suggested change) so the reclaimed
 * worker knows what to do, then setStatus('queued') (which clears the claimant) + a status_change.
 */
export function applyFeedbackFix(db: DB, key: string, actorUserId: number | null = null, now: () => string = nowIso): TaskDetail {
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  if (row.status !== 'delivering') throw new ValidationError(`apply feedback requires a delivering task (got ${row.status})`);

  const activity = toDetail(db, row).activity.filter((a) => a.type === 'comment');
  const feedback = [...activity].reverse().map((a) => parsePrFeedbackComment(a.body)).find((p): p is ParsedPrFeedback => p !== null);
  if (!feedback) throw new ValidationError('no PR feedback to apply — add feedback and evaluate it first');
  const evalv = [...activity].reverse().map((a) => parseFeedbackEvalComment(a.body)).find((p): p is ParsedFeedbackEval => p !== null) ?? null;

  return transaction(db, () => {
    const ts = now();
    assertTransition('delivering', 'queued', 'human');
    setStatus(db, row.id, 'queued', ts);
    appendActivity(db, { taskId: row.id, type: 'feedback', actor: 'human', body: composeFixFeedback(feedback, evalv), createdAt: ts, actorUserId });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'human', fromStatus: 'delivering', toStatus: 'queued', createdAt: ts, actorUserId });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
