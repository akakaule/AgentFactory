import type { DB } from '../db.js';
import type { TaskDetail, SubmitResultInput, Stage, CriterionClaim } from '../types.js';
import { transaction } from '../transaction.js';
import { submitResultSchema, parse } from '../validate.js';
import { assertTransition } from '../transitions.js';
import { findRowByKey, toDetail, setStatus, setResultSummary, setPlan, applyEdit, snapshotOriginal } from '../repo/tasks.js';
import { appendActivity } from '../repo/activity.js';
import { endSession } from '../repo/agentSessions.js';
import { insertLinks } from '../repo/links.js';
import { NotFoundError, ValidationError, InvalidTransitionError } from '../errors.js';
import { reconcileMergedDelivery } from './delivery.js';
import { nowIso } from '../time.js';
import { advanceRetryBudget } from '../repo/retry.js';
import { assertExecutionOwnership, executionById, isLatestOfPhase, settleExecution } from '../repo/execution.js';
import { parseAcceptanceCriteria } from '../acceptanceCriteria.js';
import { buildCriteriaClaimsComment } from '../criteriaClaims.js';

/**
 * Each stage delivers a different artifact through the same submit: the description
 * stage a rewritten spec + acceptance criteria, the plan stage the implementation
 * plan, the implementation stage the code (summary + links). The error text is the
 * agent's only feedback over MCP — it names the stage and the expected fields.
 */
function assertStageShape(stage: Stage, spec: string | undefined, acceptanceCriteria: string | undefined, plan: string | undefined, verification: string | undefined, criteria: CriterionClaim[] | undefined): void {
  switch (stage) {
    case 'description':
      if (spec === undefined || acceptanceCriteria === undefined || plan !== undefined || verification !== undefined || criteria !== undefined)
        throw new ValidationError('description stage submit delivers the feature description: pass { summary, spec, acceptanceCriteria }; plan/verification/criteria are not accepted');
      return;
    case 'plan':
      if (plan === undefined || spec !== undefined || acceptanceCriteria !== undefined || verification !== undefined || criteria !== undefined)
        throw new ValidationError('plan stage submit delivers the implementation plan: pass { summary, plan }; spec/acceptanceCriteria/verification/criteria are not accepted');
      return;
    case 'implementation':
      if (spec !== undefined || acceptanceCriteria !== undefined || plan !== undefined)
        throw new ValidationError('implementation stage submit delivers code: pass { summary, links, verification, criteria }; spec/acceptanceCriteria/plan are not accepted');
      return;
  }
}

/** Each claim must name one of the task's criteria, once. The message lists the valid ids — it is
 *  the agent's only feedback over MCP. Leaving criteria out is allowed. */
function assertCriterionIds(acceptanceCriteria: string, claims: CriterionClaim[]): void {
  const ids = parseAcceptanceCriteria(acceptanceCriteria).items.map((i) => i.id);
  const valid = ids.length === 0 ? 'this task has no acceptance criteria' : `this task has ${ids.length === 1 ? ids[0]! : `${ids[0]!}–${ids.at(-1)!}`}`;
  const seen = new Set<string>();
  for (const { id } of claims) {
    if (!ids.includes(id)) throw new ValidationError(`unknown criterion ${id}; ${valid}`);
    if (seen.has(id)) throw new ValidationError(`criterion ${id} is listed twice; ${valid}`);
    seen.add(id);
  }
}

export function submitResult(
  db: DB,
  key: string,
  input: SubmitResultInput,
  now: () => string = nowIso,
): TaskDetail {
  const { summary, claimAt, links, spec, acceptanceCriteria, plan, verification, criteria, executionId } = parse(submitResultSchema, input);
  return transaction(db, () => {
    const row = findRowByKey(db, key);
    if (!row) throw new NotFoundError(`task not found: ${key}`);
    assertStageShape(row.stage, spec, acceptanceCriteria, plan, verification, criteria);
    if (criteria) assertCriterionIds(row.acceptance_criteria, criteria);

    // A response can be lost after the transaction commits. A retry of that same successful
    // execution is an acknowledgement, not a second result — also once the reviewer has reserved
    // the submitted task (another phase). A newer worker execution makes the old identity stale,
    // and a retry with a different summary is refused rather than silently dropped.
    const own = executionId === undefined ? undefined : executionById(db, executionId);
    if (own !== undefined && own.task_id === row.id && own.state === 'succeeded' && row.status === 'in_review' && isLatestOfPhase(db, own)) {
      if (row.result_summary !== summary)
        throw new InvalidTransitionError(`${key} already holds the result execution ${own.id} submitted; a different retry is not applied`);
      return toDetail(db, row);
    }

    const current = assertExecutionOwnership(db, row.id, key, executionId, { requireRunning: true });
    if (executionId !== undefined && current === undefined)
      throw new InvalidTransitionError(`execution ${executionId} is not running`);
    assertTransition(row.status, 'in_review', 'agent'); // rejects unless in_progress
    if (claimAt !== undefined && row.claimed_at !== claimAt) throw new InvalidTransitionError(`stale claim for ${key}`);
    // Verification gate: when the workspace configures a verify command, the implementation stage
    // must report having run it (attestation — the worktree is gone by submit, so the server can't
    // re-run it here). No command configured ⇒ no gate, preserving today's behaviour.
    if (row.stage === 'implementation' && row.workspace_verify_command && row.workspace_verify_command.trim().length > 0 && verification === undefined)
      throw new ValidationError(`this workspace requires verification: run \`${row.workspace_verify_command}\` from the worktree root and report its outcome via the \`verification\` field`);
    const ts = now();
    if (reconcileMergedDelivery(db, row, ts)) {
      appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent',
        body: `repair result retained after merged delivery: ${summary}`, createdAt: ts });
      return toDetail(db, findRowByKey(db, key)!);
    }
    // A new result is a new review episode. Preserve failures from the prior submission but do
    // not let a successful review consume the next submission's allowance.
    advanceRetryBudget(db, row.id, `reviewer:${row.stage}`, ts, 'new submission');
    // applyEdit is the repo primitive shared with updateTask; the unclaimed-only rule for
    // human edits lives in that op, not here — a description-stage submit IS the edit.
    if (row.stage === 'description') {
      // capture the human's original wording once, before the stage overwrites it (the guard
      // in snapshotOriginal keeps re-submits from clobbering the first snapshot)
      snapshotOriginal(db, row.id, row.spec, row.acceptance_criteria, ts);
      applyEdit(db, row.id, { spec: spec!, acceptanceCriteria: acceptanceCriteria! }, ts);
    }
    else if (row.stage === 'plan') setPlan(db, row.id, plan!, ts);
    setStatus(db, row.id, 'in_review', ts);
    setResultSummary(db, row.id, summary, ts);
    endSession(db, row.id, ts); // the agent finished — drop it from the live view
    if (executionId !== undefined) settleExecution(db, executionId, 'succeeded', ts, 'result submitted');
    insertLinks(db, row.id, links ?? []);
    appendActivity(db, { taskId: row.id, type: 'result', actor: 'agent', body: summary, createdAt: ts });
    // the claim per criterion rides right after the result it belongs to (criteriaClaimsFor reads it)
    if (criteria && criteria.length > 0)
      appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: buildCriteriaClaimsComment(criteria), createdAt: ts });
    // surface the verify-command attestation in the thread so the human/reviewer can see it
    if (verification !== undefined)
      appendActivity(db, { taskId: row.id, type: 'comment', actor: 'agent', body: `verify: ${verification}`, createdAt: ts });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: 'in_progress', toStatus: 'in_review', createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
