import type { DB } from '../db.js';
import type { TaskDetail, SubmitResultInput, Stage } from '../types.js';
import { transaction } from '../transaction.js';
import { submitResultSchema, parse } from '../validate.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, setResultSummary, setPlan, applyEdit, snapshotOriginal } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { insertLinks } from '../repo/links.js';
import { NotFoundError, ValidationError } from '../errors.js';
import { nowIso } from '../time.js';
import { advanceRetryBudget } from '../repo/retry.js';
import { clearDelivery, deliveryRowFor } from '../repo/delivery.js';
import { completeDeliveryRow } from './delivery.js';

/**
 * Each stage delivers a different artifact through the same submit: the description
 * stage a rewritten spec + acceptance criteria, the plan stage the implementation
 * plan, the implementation stage the code (summary + links). The error text is the
 * agent's only feedback over MCP — it names the stage and the expected fields.
 */
function assertStageShape(stage: Stage, spec: string | undefined, acceptanceCriteria: string | undefined, plan: string | undefined, verification: string | undefined): void {
  switch (stage) {
    case 'description':
      if (spec === undefined || acceptanceCriteria === undefined || plan !== undefined || verification !== undefined)
        throw new ValidationError('description stage submit delivers the feature description: pass { summary, spec, acceptanceCriteria }; plan/verification are not accepted');
      return;
    case 'plan':
      if (plan === undefined || spec !== undefined || acceptanceCriteria !== undefined || verification !== undefined)
        throw new ValidationError('plan stage submit delivers the implementation plan: pass { summary, plan }; spec/acceptanceCriteria/verification are not accepted');
      return;
    case 'implementation':
      if (spec !== undefined || acceptanceCriteria !== undefined || plan !== undefined)
        throw new ValidationError('implementation stage submit delivers code: pass { summary, links, verification }; spec/acceptanceCriteria/plan are not accepted');
      return;
  }
}

export function submitResult(
  db: DB,
  key: string,
  input: SubmitResultInput,
  now: () => string = nowIso,
): TaskDetail {
  const { summary, links, spec, acceptanceCriteria, plan, verification } = parse(submitResultSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, 'in_review', 'agent'); // rejects unless in_progress
  assertStageShape(row.stage, spec, acceptanceCriteria, plan, verification);
  // Verification gate: when the workspace configures a verify command, the implementation stage
  // must report having run it (attestation — the worktree is gone by submit, so the server can't
  // re-run it here). No command configured ⇒ no gate, preserving today's behaviour.
  if (row.stage === 'implementation' && row.workspace_verify_command && row.workspace_verify_command.trim().length > 0 && verification === undefined)
    throw new ValidationError(`this workspace requires verification: run \`${row.workspace_verify_command}\` from the worktree root and report its outcome via the \`verification\` field`);
  return transaction(db, () => {
    // A repair worker may finish after the watcher has recorded that the approved PR merged.
    // Re-read both rows under the same lock so this late result cannot erase the delivery or
    // replace the approved result summary. Keep its work as durable activity instead.
    const current = findRowByKey(db, key);
    if (!current) throw new NotFoundError(`task not found: ${key}`);
    assertTransition(current.status, 'in_review', 'agent');
    const currentDelivery = deliveryRowFor(db, current.id);
    if (currentDelivery?.pr_state === 'merged') {
      const ts = now();
      appendActivity(db, {
        taskId: current.id, type: 'comment', actor: 'agent',
        body: `repair result retained after merged delivery: ${summary}`,
        createdAt: ts,
      });
      insertLinks(db, current.id, links ?? []);
      if (verification !== undefined)
        appendActivity(db, { taskId: current.id, type: 'comment', actor: 'agent', body: `verify: ${verification}`, createdAt: ts });
      completeDeliveryRow(db, current, currentDelivery, ts);
      return toDetail(db, findRowByKey(db, key)!);
    }
    const ts = now();
    // A new result is a new review episode. Preserve failures from the prior submission but do
    // not let a successful review consume the next submission's allowance.
    advanceRetryBudget(db, row.id, `reviewer:${row.stage}`, ts, 'new submission');
    // A new implementation result supersedes the previously approved delivery episode. Keeping
    // its row would let a slow watcher observation for the old PR complete this new review.
    if (current.stage === 'implementation') clearDelivery(db, current.id);
    // applyEdit is the repo primitive shared with updateTask; the backlog-only rule for
    // human edits lives in that op, not here — a description-stage submit IS the edit.
    if (current.stage === 'description') {
      // capture the human's original wording once, before the stage overwrites it (the guard
      // in snapshotOriginal keeps re-submits from clobbering the first snapshot)
      snapshotOriginal(db, current.id, current.spec, current.acceptance_criteria, ts);
      applyEdit(db, current.id, { spec: spec!, acceptanceCriteria: acceptanceCriteria! }, ts);
    }
    else if (current.stage === 'plan') setPlan(db, current.id, plan!, ts);
    setStatus(db, current.id, 'in_review', ts);
    setResultSummary(db, current.id, summary, ts);
    endSession(db, current.id, ts); // the agent finished — drop it from the live view
    insertLinks(db, current.id, links ?? []);
    appendActivity(db, { taskId: current.id, type: 'result', actor: 'agent', body: summary, createdAt: ts });
    // surface the verify-command attestation in the thread so the human/reviewer can see it
    if (verification !== undefined)
      appendActivity(db, { taskId: current.id, type: 'comment', actor: 'agent', body: `verify: ${verification}`, createdAt: ts });
    appendActivity(db, { taskId: current.id, type: 'status_change', actor: 'agent', fromStatus: current.status, toStatus: 'in_review', createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
