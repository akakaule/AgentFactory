export { openDb, type DB } from './db.js';
export { runMigrations } from './migrate.js';
export * from './types.js';
export { NotFoundError, InvalidTransitionError, ValidationError } from './errors.js';
export { getVersion } from './version.js';
export { createTask } from './ops/createTask.js';
export { updateTask } from './ops/updateTask.js';
export { deleteTask } from './ops/deleteTask.js';
export { listTasks } from './ops/listTasks.js';
export { getTask } from './ops/getTask.js';
export { claimNextTask, type ClaimOptions, type ClaimResult } from './ops/claimNextTask.js';
export { featureBranch, kebabTitle } from './branch.js';
export { parseAiReview, findingsAtApproval } from './aiReview.js';
export { addComment } from './ops/addComment.js';
export { submitResult } from './ops/submitResult.js';
export { updateStatus } from './ops/updateStatus.js';
export { reviewApprove } from './ops/reviewApprove.js';
export { reviewRequestChanges } from './ops/reviewRequestChanges.js';
export { analyticsRows, type AnalyticsTaskRow, type StrandedRelease, type AnalyticsData } from './ops/analyticsRows.js';
export { addTaskMetrics } from './ops/addTaskMetrics.js';
export { addAttachment } from './ops/addAttachment.js';
export { deleteAttachment } from './ops/deleteAttachment.js';
export { getAttachment } from './ops/getAttachment.js';
export { deriveTaskMetrics, type DerivedTaskMetrics, type ActivityStep } from './metrics.js';
export { createWorkspace } from './ops/createWorkspace.js';
export { listWorkspaces } from './ops/listWorkspaces.js';

import { openDb, type DB } from './db.js';
import { runMigrations } from './migrate.js';
import { getVersion } from './version.js';
import { createTask } from './ops/createTask.js';
import { updateTask } from './ops/updateTask.js';
import { deleteTask } from './ops/deleteTask.js';
import { listTasks } from './ops/listTasks.js';
import { getTask } from './ops/getTask.js';
import { claimNextTask, type ClaimOptions } from './ops/claimNextTask.js';
import { addComment } from './ops/addComment.js';
import { submitResult } from './ops/submitResult.js';
import { updateStatus } from './ops/updateStatus.js';
import { reviewApprove } from './ops/reviewApprove.js';
import { reviewRequestChanges } from './ops/reviewRequestChanges.js';
import { analyticsRows } from './ops/analyticsRows.js';
import { addTaskMetrics } from './ops/addTaskMetrics.js';
import { addAttachment } from './ops/addAttachment.js';
import { deleteAttachment } from './ops/deleteAttachment.js';
import { getAttachment } from './ops/getAttachment.js';
import { createWorkspace } from './ops/createWorkspace.js';
import { listWorkspaces } from './ops/listWorkspaces.js';
import type { Status, Actor, CreateTaskInput, UpdateTaskInput, SubmitResultInput, CreateWorkspaceInput, AddTaskMetricsInput, AddAttachmentInput } from './types.js';

/** Bind every op to a single DB handle — the surface the mcp/web adapters consume. */
export function createCore(db: DB) {
  return {
    createTask: (input: CreateTaskInput) => createTask(db, input),
    updateTask: (key: string, fields: UpdateTaskInput) => updateTask(db, key, fields),
    deleteTask: (key: string) => deleteTask(db, key),
    listTasks: (opts: { status?: Status | undefined; workspace?: string | undefined } = {}) => listTasks(db, opts),
    getTask: (key: string) => getTask(db, key),
    claimNextTask: (opts?: ClaimOptions) => claimNextTask(db, opts),
    createWorkspace: (input: CreateWorkspaceInput) => createWorkspace(db, input),
    listWorkspaces: () => listWorkspaces(db),
    addComment: (key: string, input: { actor: Actor; body: string }) => addComment(db, key, input),
    submitResult: (key: string, input: SubmitResultInput) => submitResult(db, key, input),
    updateStatus: (key: string, status: Status, actor: Actor) => updateStatus(db, key, status, actor),
    reviewApprove: (key: string) => reviewApprove(db, key),
    reviewRequestChanges: (key: string, input: { feedback: string }) => reviewRequestChanges(db, key, input),
    analyticsRows: () => analyticsRows(db),
    addTaskMetrics: (key: string, input: AddTaskMetricsInput) => addTaskMetrics(db, key, input),
    addAttachment: (key: string, input: AddAttachmentInput) => addAttachment(db, key, input),
    deleteAttachment: (id: number) => deleteAttachment(db, id),
    getAttachment: (id: number) => getAttachment(db, id),
    getVersion: () => getVersion(db),
  };
}
export type Core = ReturnType<typeof createCore>;

/** Open + migrate a DB and return a bound Core — the one-call entry for adapters. */
export function openCore(path: string): Core {
  const db = openDb(path);
  runMigrations(db);
  return createCore(db);
}
