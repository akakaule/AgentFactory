import type { DB } from '../db.js';
import type { TaskDetail, AddTaskMetricsInput } from '../types.js';
import { findRowByKey, toDetail } from '../repo/tasks.js';
import { insertMetric } from '../repo/metrics.js';
import { taskMetricsSchema, parse } from '../validate.js';
import { NotFoundError } from '../errors.js';
import { nowIso } from '../time.js';

/** Record a worker-reported usage report (best-effort at submit, or exact post-run). */
export function addTaskMetrics(db: DB, key: string, input: AddTaskMetricsInput, now: () => string = nowIso): TaskDetail {
  const m = parse(taskMetricsSchema, input);
  const row = findRowByKey(db, key);
  if (!row) throw new NotFoundError(`task not found: ${key}`);
  insertMetric(db, {
    taskId: row.id,
    model: m.model ?? null,
    tokensIn: m.tokensIn ?? null,
    tokensOut: m.tokensOut ?? null,
    costUsd: m.costUsd ?? null,
    reportedBy: m.reportedBy ?? null,
    createdAt: now(),
  });
  return toDetail(db, row);
}
