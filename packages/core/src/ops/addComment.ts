import type { DB } from '../db.js';
import type { Activity, Actor } from '../types.js';
import { AUTO_REVIEW_LIMIT } from '../types.js';
import { transaction } from '../transaction.js';
import { commentSchema, parse } from '../validate.js';
import { findRowByKey, incrementAutoReviewRounds, setStatus, touch } from '../repo/tasks.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { composeAiReviewFeedback, parseAiReviewComment } from '../aiReview.js';
import { applyApproval } from './approval.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

export function addComment(
  db: DB,
  key: string,
  input: { actor: Actor; body: string; actorUserId?: number | null },
  now: () => string = nowIso,
): Activity {
  const { body } = parse(commentSchema, { body: input.body });
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  return transaction(db, () => {
    const ts = now();
    appendActivity(db, { taskId: row.id, type: 'comment', actor: input.actor, body, createdAt: ts, actorUserId: input.actorUserId ?? null });
    touch(db, row.id, ts);
    const comment = recentActivity(db, row.id, 1)[0]!; // capture before the hook appends more rows
    // Auto-approve policy: a clean ai-review/v1 verdict on an in-review doc stage advances
    // the task to its next stage. Keyed on the incoming body itself (the newest activity by
    // construction), regardless of actor — the reviewer loop posts via HTTP (human) or MCP
    // (agent). Findings, malformed markers, and the implementation stage all escalate to
    // the human gate instead. Reviewers stay advisory; this policy lives here, in core.
    const parsed = parseAiReviewComment(body);
    if (parsed && parsed.findings.length > 0 && row.status === 'in_review' && row.kind === 'code' && row.auto_review_enabled === 1) {
      if (row.auto_review_rounds >= AUTO_REVIEW_LIMIT) {
        appendActivity(db, {
          taskId: row.id,
          type: 'comment',
          actor: 'agent',
          body: `auto AI review loop paused: reached ${AUTO_REVIEW_LIMIT} automatic rework rounds; human review required.`,
          createdAt: ts,
        });
      } else {
        appendActivity(db, {
          taskId: row.id,
          type: 'feedback',
          actor: 'agent',
          body: composeAiReviewFeedback(parsed),
          createdAt: ts,
        });
        incrementAutoReviewRounds(db, row.id, ts);
        setStatus(db, row.id, 'queued', ts);
        appendActivity(db, {
          taskId: row.id,
          type: 'status_change',
          actor: 'agent',
          fromStatus: 'in_review',
          toStatus: 'queued',
          body: `auto AI review feedback: ${parsed.findings.length} finding${parsed.findings.length === 1 ? '' : 's'} sent back`,
          createdAt: ts,
        });
      }
    } else if (parsed && parsed.findings.length === 0 && row.status === 'in_review' && row.stage !== 'implementation') {
      applyApproval(db, row, 'agent', ts, 'auto-approved: clean AI review');
    }
    return comment;
  });
}
