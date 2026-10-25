import type { DB } from '../db.js';
import type { Task, CreateTaskInput } from '../types.js';
import { DEFAULT_WORKSPACE } from '../types.js';
import { transaction } from '../transaction.js';
import { createTaskSchema, parse } from '../validate.js';
import { assignKeyAndSeq } from '../keygen.js';
import { appendActivity } from '../repo/activity.js';
import { findByKey } from '../repo/tasks.js';
import { insertLinks } from '../repo/links.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { nowIso } from '../time.js';
import { PLACEHOLDER_ACCEPTANCE_CRITERIA } from '../acceptanceCriteria.js';

export function createTask(db: DB, input: CreateTaskInput, now: () => string = nowIso): Task {
  return transaction(db, () => createTaskWithinTransaction(db, input, now));
}

/** The body of createTask, for ops that compose it into their own transaction (importTask). */
export function createTaskWithinTransaction(db: DB, input: CreateTaskInput, now: () => string = nowIso): Task {
  const { title, spec, acceptanceCriteria, stage, kind, links, workspace } = parse(createTaskSchema, input);
  {
    const ws = requireWorkspaceByName(db, workspace ?? DEFAULT_WORKSPACE);
    const ts = now();
    const info = db.prepare(
      `INSERT INTO task(key,title,spec,acceptance_criteria,status,stage,kind,result_summary,seq,workspace_id,created_at,updated_at)
       VALUES ('',?,?,?,'backlog',?,?,NULL,0,?,?,?)`
      // AC may only be omitted at the description stage (validated) — that stage writes them
    ).run(title, spec, acceptanceCriteria ?? PLACEHOLDER_ACCEPTANCE_CRITERIA, stage ?? 'implementation', kind ?? 'code', ws.id, ts, ts);
    const id = Number(info.lastInsertRowid);
    const key = assignKeyAndSeq(db, id);
    // a PR-review task arrives with its head-branch link (the reviewer/diff route read it) + an optional pr link
    if (links && links.length > 0) insertLinks(db, id, links);
    // actor rides outside createTaskSchema (parse strips it) — read it from the raw input; default human.
    appendActivity(db, { taskId: id, type: 'status_change', actor: input.actor ?? 'human', fromStatus: null, toStatus: 'backlog', createdAt: ts });
    return findByKey(db, key)!;
  }
}
