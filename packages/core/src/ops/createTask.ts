import type { DB } from '../db.js';
import type { Task, CreateTaskInput } from '../types.js';
import { DEFAULT_WORKSPACE } from '../types.js';
import { transaction } from '../transaction.js';
import { createTaskSchema, parse } from '../validate.js';
import { assignKeyAndSeq } from '../keygen.js';
import { appendActivity } from '../repo/activity.js';
import { findByKey } from '../repo/tasks.js';
import { requireWorkspaceByName } from '../repo/workspaces.js';
import { nowIso } from '../time.js';

export function createTask(db: DB, input: CreateTaskInput, now: () => string = nowIso): Task {
  const { title, spec, acceptanceCriteria, workspace } = parse(createTaskSchema, input);
  return transaction(db, () => {
    const ws = requireWorkspaceByName(db, workspace ?? DEFAULT_WORKSPACE);
    const ts = now();
    const info = db.prepare(
      `INSERT INTO task(key,title,spec,acceptance_criteria,status,result_summary,seq,workspace_id,created_at,updated_at)
       VALUES ('',?,?,?,'backlog',NULL,0,?,?,?)`
    ).run(title, spec, acceptanceCriteria, ws.id, ts, ts);
    const id = Number(info.lastInsertRowid);
    const key = assignKeyAndSeq(db, id);
    appendActivity(db, { taskId: id, type: 'status_change', actor: 'human', fromStatus: null, toStatus: 'backlog', createdAt: ts });
    return findByKey(db, key)!;
  });
}
