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

/**
 * Each stage delivers a different artifact through the same submit: the description
 * stage a rewritten spec + acceptance criteria, the plan stage the implementation
 * plan, the implementation stage the code (summary + links). The error text is the
 * agent's only feedback over MCP — it names the stage and the expected fields.
 */
function assertStageShape(stage: Stage, spec: string | undefined, acceptanceCriteria: string | undefined, plan: string | undefined): void {
  switch (stage) {
    case 'description':
      if (spec === undefined || acceptanceCriteria === undefined || plan !== undefined)
        throw new ValidationError('description stage submit delivers the feature description: pass { summary, spec, acceptanceCriteria }; plan is not accepted');
      return;
    case 'plan':
      if (plan === undefined || spec !== undefined || acceptanceCriteria !== undefined)
        throw new ValidationError('plan stage submit delivers the implementation plan: pass { summary, plan }; spec/acceptanceCriteria are not accepted');
      return;
    case 'implementation':
      if (spec !== undefined || acceptanceCriteria !== undefined || plan !== undefined)
        throw new ValidationError('implementation stage submit delivers code: pass { summary, links }; spec/acceptanceCriteria/plan are not accepted');
      return;
  }
}

export function submitResult(
  db: DB,
  key: string,
  input: SubmitResultInput,
  now: () => string = nowIso,
): TaskDetail {
  const { summary, links, spec, acceptanceCriteria, plan } = parse(submitResultSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  assertTransition(row.status, 'in_review', 'agent'); // rejects unless in_progress
  assertStageShape(row.stage, spec, acceptanceCriteria, plan);
  return transaction(db, () => {
    const ts = now();
    // applyEdit is the repo primitive shared with updateTask; the backlog-only rule for
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
    insertLinks(db, row.id, links ?? []);
    appendActivity(db, { taskId: row.id, type: 'result', actor: 'agent', body: summary, createdAt: ts });
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: 'in_progress', toStatus: 'in_review', createdAt: ts });
    return toDetail(db, findRowByKey(db, key)!);
  });
}
