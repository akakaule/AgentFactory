export { openDb, type DB } from './db.js';
export { runMigrations } from './migrate.js';
export * from './types.js';
export { NotFoundError, InvalidTransitionError, ValidationError } from './errors.js';
export { getVersion } from './version.js';
export { createTask } from './ops/createTask.js';
export { updateTask } from './ops/updateTask.js';
export { deleteTask } from './ops/deleteTask.js';
export { archiveTask, unarchiveTask, archiveDoneTasks } from './ops/archiveTask.js';
export { listTasks } from './ops/listTasks.js';
export { getTask } from './ops/getTask.js';
export { claimNextTask, type ClaimOptions, type ClaimResult } from './ops/claimNextTask.js';
export { featureBranch, kebabTitle } from './branch.js';
export { branchDiff, resolveBaseRef, refFromLabel, fetchRemoteRef, GitError, type BranchDiff } from './git.js';
export { isAiReviewMarker, parseAiReviewComment, summarizeAiReview, findingsAtApproval, type ParsedAiReview } from './aiReview.js';
export { isFailureMarker, parseFailureComment, summarizeFailure, buildFailureComment, isRestartMarker, buildRestartComment, FAILURE_REASONS, type FailureReason, type ParsedFailure, type FailureCommentInput } from './failure.js';
export { parseRemoteUrl, resolveOriginUrl, type RemoteRef } from './remote.js';
export { resolveGitAuth, gitAuthConfigPairs, bareHttpUrl, type GitAuth } from './gitAuth.js';
export { perWorkspaceEnvVar, BASE_ENV_VAR } from './patEnv.js';
export { getDelivery, beginDelivery, recordDeliveryCheck, completeDelivery, failDelivery, type DeliveryFailureReason } from './ops/delivery.js';
export { type DeliveryObservation } from './repo/delivery.js';
export { addComment } from './ops/addComment.js';
export { submitResult } from './ops/submitResult.js';
export { updateStatus } from './ops/updateStatus.js';
export { restartTask } from './ops/restartTask.js';
export { reviewApprove } from './ops/reviewApprove.js';
export { reviewPrReviewed, PR_REVIEW_FEEDBACK_MARKER } from './ops/reviewPrReviewed.js';
export { reviewRequestChanges } from './ops/reviewRequestChanges.js';
export { analyticsRows, type AnalyticsTaskRow, type StrandedRelease, type FailureEvent, type AnalyticsData } from './ops/analyticsRows.js';
export { addTaskMetrics } from './ops/addTaskMetrics.js';
export { addAttachment } from './ops/addAttachment.js';
export { deleteAttachment } from './ops/deleteAttachment.js';
export { getAttachment } from './ops/getAttachment.js';
export { deriveTaskMetrics, type DerivedTaskMetrics, type ActivityStep } from './metrics.js';
export { createWorkspace } from './ops/createWorkspace.js';
export { updateWorkspace } from './ops/updateWorkspace.js';
export { listWorkspaces } from './ops/listWorkspaces.js';
export { resolveServedWorkspaces } from './workspaceSelection.js';
export { createUser, createApiToken, authenticateToken, type CreatedApiToken, type AuthedToken } from './ops/auth.js';
export { generateToken, hashToken } from './token.js';
export { reportProgress, touchAgentSession, endAgentSession, listLiveAgents } from './ops/agentSession.js';
export { parseTranscript } from './transcript.js';
export { appendTranscript, saveTranscript, getTranscript, type AppendTranscriptInput, type SaveTranscriptInput } from './ops/transcript.js';
export { attachVisualization, getVisualization, getVisualizationHtml, type AttachVisualizationInput } from './ops/visualization.js';
export { type VisualizationMeta } from './repo/visualizations.js';
export { recordSupervisorHeartbeat, listSupervisors } from './ops/supervisorHeartbeat.js';
export { type UpsertSupervisor } from './repo/supervisors.js';
export { activitySince, latestActivityId } from './repo/activity.js';
export { getKv, setKv } from './repo/kv.js';

import { openDb, type DB } from './db.js';
import { runMigrations } from './migrate.js';
import { getVersion } from './version.js';
import { createTask } from './ops/createTask.js';
import { updateTask } from './ops/updateTask.js';
import { deleteTask } from './ops/deleteTask.js';
import { archiveTask, unarchiveTask, archiveDoneTasks } from './ops/archiveTask.js';
import { listTasks } from './ops/listTasks.js';
import { getTask } from './ops/getTask.js';
import { claimNextTask, type ClaimOptions } from './ops/claimNextTask.js';
import { addComment } from './ops/addComment.js';
import { submitResult } from './ops/submitResult.js';
import { updateStatus } from './ops/updateStatus.js';
import { restartTask } from './ops/restartTask.js';
import { reviewApprove } from './ops/reviewApprove.js';
import { getDelivery, beginDelivery, recordDeliveryCheck, completeDelivery, failDelivery, type DeliveryFailureReason } from './ops/delivery.js';
import type { DeliveryObservation } from './repo/delivery.js';
import { resolveOriginUrl } from './remote.js';
import { resolveGitAuth } from './gitAuth.js';
import { getWorkspacePat } from './repo/workspaces.js';
import { reviewPrReviewed } from './ops/reviewPrReviewed.js';
import { reviewRequestChanges } from './ops/reviewRequestChanges.js';
import { analyticsRows } from './ops/analyticsRows.js';
import { addTaskMetrics } from './ops/addTaskMetrics.js';
import { addAttachment } from './ops/addAttachment.js';
import { deleteAttachment } from './ops/deleteAttachment.js';
import { getAttachment } from './ops/getAttachment.js';
import { createWorkspace } from './ops/createWorkspace.js';
import { updateWorkspace } from './ops/updateWorkspace.js';
import { listWorkspaces } from './ops/listWorkspaces.js';
import { createUser, createApiToken, authenticateToken } from './ops/auth.js';
import { reportProgress, touchAgentSession, endAgentSession, listLiveAgents } from './ops/agentSession.js';
import { appendTranscript, saveTranscript, getTranscript, type AppendTranscriptInput, type SaveTranscriptInput } from './ops/transcript.js';
import { attachVisualization, getVisualization, getVisualizationHtml, type AttachVisualizationInput } from './ops/visualization.js';
import { recordSupervisorHeartbeat, listSupervisors } from './ops/supervisorHeartbeat.js';
import type { UpsertSupervisor } from './repo/supervisors.js';
import { activitySince, latestActivityId } from './repo/activity.js';
import { getKv, setKv } from './repo/kv.js';
import { nowIso } from './time.js';
import type { Status, Actor, CreateTaskInput, UpdateTaskInput, SubmitResultInput, CreateWorkspaceInput, UpdateWorkspaceInput, AddTaskMetricsInput, AddAttachmentInput, DeliveryProvider } from './types.js';

export interface CoreOptions {
  /** Injectable origin-URL resolver for the approve→delivering routing (tests pass a fake;
   *  production defaults to shelling `git remote get-url origin` — see remote.ts). */
  resolveOrigin?: ((repoPath: string) => string | null) | undefined;
}

/** Bind every op to a single DB handle — the surface the mcp/web adapters consume. */
export function createCore(db: DB, opts: CoreOptions = {}) {
  const resolveOrigin = opts.resolveOrigin ?? resolveOriginUrl;
  return {
    createTask: (input: CreateTaskInput) => createTask(db, input),
    updateTask: (key: string, fields: UpdateTaskInput) => updateTask(db, key, fields),
    deleteTask: (key: string) => deleteTask(db, key),
    archiveTask: (key: string) => archiveTask(db, key),
    unarchiveTask: (key: string) => unarchiveTask(db, key),
    archiveDoneTasks: (opts: { workspace?: string | undefined } = {}) => archiveDoneTasks(db, opts),
    listTasks: (opts: { status?: Status | undefined; workspace?: string | undefined; archived?: boolean | undefined } = {}) => listTasks(db, opts),
    getTask: (key: string) => getTask(db, key),
    claimNextTask: (opts?: ClaimOptions) => claimNextTask(db, opts),
    createWorkspace: (input: CreateWorkspaceInput) => createWorkspace(db, input),
    updateWorkspace: (name: string, input: UpdateWorkspaceInput) => updateWorkspace(db, name, input),
    listWorkspaces: () => listWorkspaces(db),
    /** The git auth (http.extraheader against a bare origin) for a workspace, or null — used by
     *  the dispatcher (worker git env) and the MCP submit-verify. Resolves DB PAT → env → null. */
    resolveGitAuth: (workspace: string) => resolveGitAuth(db, workspace, { env: process.env, resolveOrigin }),
    /** The raw stored PAT for a workspace, or null (watcher REST credential). Secret — never serialize. */
    getWorkspacePat: (workspace: string) => getWorkspacePat(db, workspace),
    createUser: (input: { email: string; displayName?: string; oidcSubject?: string | null; isSystem?: boolean }) => createUser(db, input),
    createApiToken: (input: { label: string; userId?: number | null; isService?: boolean }) => createApiToken(db, input),
    authenticateToken: (rawToken: string) => authenticateToken(db, rawToken),
    reportProgress: (key: string, input: { message: string; tokensIn?: number; tokensOut?: number }) => reportProgress(db, key, input),
    touchAgentSession: (key: string) => touchAgentSession(db, key),
    endAgentSession: (key: string) => endAgentSession(db, key),
    listLiveAgents: () => listLiveAgents(db),
    appendTranscript: (key: string, input: AppendTranscriptInput) => appendTranscript(db, key, input),
    saveTranscript: (key: string, input: SaveTranscriptInput) => saveTranscript(db, key, input),
    getTranscript: (key: string) => getTranscript(db, key),
    attachVisualization: (key: string, input: AttachVisualizationInput) => attachVisualization(db, key, input),
    getVisualization: (key: string) => getVisualization(db, key),
    getVisualizationHtml: (key: string) => getVisualizationHtml(db, key),
    recordSupervisorHeartbeat: (input: UpsertSupervisor) => recordSupervisorHeartbeat(db, input),
    listSupervisors: () => listSupervisors(db),
    activitySince: (sinceId: number, limit?: number) => activitySince(db, sinceId, limit),
    latestActivityId: () => latestActivityId(db),
    getKv: (key: string) => getKv(db, key),
    setKv: (key: string, value: string) => setKv(db, key, value),
    addComment: (key: string, input: { actor: Actor; body: string; actorUserId?: number | null }) => addComment(db, key, input),
    submitResult: (key: string, input: SubmitResultInput) => submitResult(db, key, input),
    updateStatus: (key: string, status: Status, actor: Actor, actorUserId: number | null = null, note?: string) => updateStatus(db, key, status, actor, nowIso, actorUserId, note),
    restartTask: (key: string, actorUserId: number | null = null) => restartTask(db, key, actorUserId),
    reviewApprove: (key: string, actorUserId: number | null = null) => reviewApprove(db, key, nowIso, actorUserId, resolveOrigin),
    getDelivery: (key: string) => getDelivery(db, key),
    beginDelivery: (key: string, seed: { provider: DeliveryProvider; branch: string; prUrl?: string | null }) => beginDelivery(db, key, seed),
    recordDeliveryCheck: (key: string, obs: DeliveryObservation) => recordDeliveryCheck(db, key, obs),
    completeDelivery: (key: string, note: string) => completeDelivery(db, key, note),
    failDelivery: (key: string, input: { reason: DeliveryFailureReason; detail: string; body?: string | undefined }) => failDelivery(db, key, input),
    reviewPrReviewed: (key: string, input: { review?: string | undefined; actorUserId?: number | null }) => reviewPrReviewed(db, key, input),
    reviewRequestChanges: (key: string, input: { feedback: string; actorUserId?: number | null }) => reviewRequestChanges(db, key, input),
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
export function openCore(path: string, opts: CoreOptions = {}): Core {
  const db = openDb(path);
  runMigrations(db);
  return createCore(db, opts);
}
