export { openDb, type DB } from './db.js';
export { runMigrations } from './migrate.js';
export * from './types.js';
export { INTAKE_MARKER, INTAKE_OVERRIDE_MARKER, INTAKE_CLAIM_MARKER, INTAKE_QUESTION_SET, INTAKE_POLICY_VERSION, INTAKE_MARKER_PREFIXES, isIntakeMarker, isIntakeAssessmentMarker, parseIntakeAssessment, parseIntakeComment, validateIntakeAssessment, buildIntakeComment, buildIntakeOverrideComment, intakeOverrideRevision, buildIntakeClaimComment, parseIntakeClaimComment, intakeRevision, normalizeIntakeText, evaluateIntakePolicy, intakeQueueGate, skipSpecDecision, type IntakeRevisionInput, type IntakeClaimContext } from './intake.js';
export { defaultIntakeSettings, normalizeIntakeSettings, parseIntakeSettingsUpdate, intakeEnabledFor, INTAKE_SETTINGS_KEY } from './intakeSettings.js';
export { reviewSubmissionFingerprint, candidateOutcome, consensusFindings, consensusSchema, consensusVoteSchema, consensusFindingSchema, criterionIdsSchema, VOTE_REASON_MAX, parseConsensusReview, type ReviewConsensus, type ConsensusCandidate, type ConsensusVote } from './reviewConsensus.js';
export { NotFoundError, InvalidTransitionError, ValidationError } from './errors.js';
export { getVersion } from './version.js';
export { createTask } from './ops/createTask.js';
export { importTask, type ImportTaskInput } from './ops/importTask.js';
export { updateTask } from './ops/updateTask.js';
export { deleteTask } from './ops/deleteTask.js';
export { archiveTask, unarchiveTask, archiveDoneTasks } from './ops/archiveTask.js';
export { expectedRevisionOf } from './ops/approval.js';
export { listTasks } from './ops/listTasks.js';
export { getTask } from './ops/getTask.js';
export { addTaskDependency, removeTaskDependency } from './ops/taskDependencies.js';
export { claimNextTask, type ClaimOptions, type ClaimResult } from './ops/claimNextTask.js';
export { reserveExecution, reconcileExecutions, touchExecution, getCurrentExecution, EXECUTION_LEASE_MS, type ReserveExecutionInput } from './ops/execution.js';
export { featureBranch, kebabTitle } from './branch.js';
export { branchDiff, resolveBaseRef, refFromLabel, fetchRemoteRef, remoteBranchHead, revisionDiff, GitError, type BranchDiff, type RemoteHead } from './git.js';
export { observeRevision, issueRevisionReadTicket, type RevisionObservationInput } from './ops/observeRevision.js';
export { isAiReviewMarker, parseAiReviewComment, summarizeAiReview, findingsAtApproval, normalizeCriteria, normalizeFix, formatReviewRevision, parseReviewRevision, type ParsedAiReview } from './aiReview.js';
export { parseAcceptanceCriteria, PLACEHOLDER_ACCEPTANCE_CRITERIA, type AcceptanceCriterion, type ParsedCriteria } from './acceptanceCriteria.js';
export { buildReviewBrief } from './reviewBrief.js';
export { CRITERIA_CLAIMS_MARKER, isCriteriaClaimsMarker, buildCriteriaClaimsComment, parseCriteriaClaims } from './criteriaClaims.js';
export { isFailureMarker, parseFailureComment, summarizeFailure, buildFailureComment, isRestartMarker, buildRestartComment, FAILURE_REASONS, type FailureReason, type ParsedFailure, type FailureCommentInput } from './failure.js';
export { parseRemoteUrl, resolveOriginUrl, pullRequestCreateUrl, type RemoteRef } from './remote.js';
export { effectiveWorkspaceProfile, DEFAULT_CI_MODE, type EffectiveWorkspaceProfile, type ProfileSource } from './workspaceProfile.js';
export { diagnoseWorkspace, defaultDiagnoseProbes, type DiagnoseProbes, type DiagnosticCheck, type DiagnosticId, type DiagnosticStatus, type WorkspaceDiagnosis } from './diagnoseWorkspace.js';
export { adoSyncSettingsSchema, defaultAdoSyncSettings, parseAdoSyncSettings, buildInboundWiql, htmlToText, adoIdFromTitle, ADO_IMPORT_MARKER, type AdoSyncSettings, type AdoSyncSettingsInput } from './adoSync.js';
export { AGENT_ENGINES, isAgentEngine, resolveEngine, normalizeEngineSettings, defaultEngineSettings, type AgentEngine, type EngineSettings } from './engineSettings.js';
export { EFFORTS, MODEL_CATALOG, MODEL_ID_PATTERN, MAX_REVIEWERS, emptyAgentModels, normalizeAgentModels, resolveAgentModel, resolveReviewers, modelProfileArgs, profileFromArgs, type Effort, type ModelCatalogEntry, type ModelProfile, type AgentModelStages, type AgentModelLayer, type WorkspaceModelLayer, type AgentModels, type AgentModelRole, type ReportedProfile, type ReportedRoles, type AgentModelDefaultsReport, type AgentModelDefaults } from './agentModels.js';
export { DEFAULT_MODEL_PRICES, priceUsage, type ModelPrice, type ModelPrices } from './modelPrices.js';
export { isPrFeedbackMarker, parsePrFeedbackComment, buildPrFeedbackComment, isFeedbackEvalMarker, parseFeedbackEvalComment, buildFeedbackEvalComment, FEEDBACK_DISPOSITIONS, type FeedbackDisposition, type ParsedPrFeedback, type ParsedFeedbackEval } from './prFeedback.js';
export { addPrFeedback, type AddPrFeedbackInput } from './ops/addPrFeedback.js';
export { applyFeedbackFix } from './ops/applyFeedbackFix.js';
export { resolveGitAuth, gitAuthConfigPairs, bareHttpUrl, type GitAuth } from './gitAuth.js';
export { listCredentialHealth, recordCredentialCheck, EXPIRY_WARN_DAYS, type CredentialCheck, type CredentialHealthView, type CredentialState, type CredentialStatus } from './credentialHealth.js';
export { probeCredential, parseGithubExpiry } from './probeCredential.js';
export { perWorkspaceEnvVar, BASE_ENV_VAR } from './patEnv.js';
export { AGENT_PROMPT_KEYS, getGlobalPrompts, setGlobalPrompts, resolveAgentPrompt, getWorkspacePromptOverrides, isAgentPromptKey, type AgentPromptKey, type AgentPrompts } from './agentPrompts.js';
export { getDelivery, beginDelivery, recordDeliveryCheck, recordDeliveryCheckFailure, completeDelivery, failDelivery, awaitingPostMergeChecks, POST_MERGE_CHECK_PUBLICATION_MS, type DeliveryFailureReason, type DeliveryCheckFailureInput } from './ops/delivery.js';
export { type DeliveryObservation, type DeliveryChecksTarget } from './repo/delivery.js';
export { addComment } from './ops/addComment.js';
export { submitResult } from './ops/submitResult.js';
export { updateStatus } from './ops/updateStatus.js';
export { releaseClaim } from './ops/releaseClaim.js';
export { createHttpCore, assertBoardCapabilities, type HttpCore, type HttpCoreOptions, type BoardIdentity } from './httpCore.js';
export { boardSchema, repoPathOverridesSchema, xorDbBoard, resolveBoardToken, assertAbsoluteOverrides, DEFAULT_TOKEN_ENV, type BoardConfig } from './boardConfig.js';
export { restartTask } from './ops/restartTask.js';
export { reserveRetry, settleRetry, reconcileRetry, reconcileAbandonedRetryReservations, recordRetryFailure, getRetryBudget, resetRetryBudget, type ReserveRetryInput, type SettleRetryInput, type ReconcileRetryInput, type RecordRetryFailureInput } from './ops/retry.js';
export { reviewApprove } from './ops/reviewApprove.js';
export { reviewPrReviewed, PR_REVIEW_FEEDBACK_MARKER } from './ops/reviewPrReviewed.js';
export { reviewRequestChanges } from './ops/reviewRequestChanges.js';
export { analyticsRows, type AnalyticsTaskRow, type StrandedRelease, type FailureEvent, type AnalyticsData } from './ops/analyticsRows.js';
export { spendByDay, type SpendRow, type SpendMonth } from './ops/spendByDay.js';
export { estimatePastCosts, PAST_COST_CACHED_SHARE } from './ops/estimatePastCosts.js';
export { addTaskMetrics } from './ops/addTaskMetrics.js';
export { recordVerification, latestVerification } from './ops/verification.js';
export { verificationEvidence, type EvidenceSource } from './verificationEvidence.js';
export { addAttachment } from './ops/addAttachment.js';
export { deleteAttachment } from './ops/deleteAttachment.js';
export { getAttachment } from './ops/getAttachment.js';
export { deriveTaskMetrics, type DerivedTaskMetrics, type ActivityStep } from './metrics.js';
export { createWorkspace } from './ops/createWorkspace.js';
export { updateWorkspace } from './ops/updateWorkspace.js';
export { listWorkspaces } from './ops/listWorkspaces.js';
export { getWorkspace } from './ops/getWorkspace.js';
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
export { getIntakeSettings, setIntakeSettings } from './ops/intakeSettings.js';
export { recordIntakeAssessment, beginIntakeAssessment, intakeHistory, overrideIntake, queueWithIntakeAcknowledgment, intakeRuntimeSettings, type BeginIntakeAssessmentResult } from './ops/intake.js';
export { activitySince, latestActivityId } from './repo/activity.js';
export { getKv, setKv } from './repo/kv.js';
export { captureNotifications, listAttentionOccurrences, listOpenAttention, listNotificationOutbox, listAllNotificationOutbox, settleNotificationOutbox, resolveAttention, snoozeAttention } from './ops/notifications.js';
export { type RecentTokenMetric } from './repo/metrics.js';
export {
  FAILURE_TRIAGE_MARKER, FAILURE_TRIAGE_FEEDBACK_MARKER, FAILURE_TRIAGE_MARKER_PREFIXES, FAILURE_TRIAGE_CATEGORIES, FAILURE_TRIAGE_TAXONOMY,
  FAILURE_TRIAGE_DISPLAY_VERSION, FAILURE_TRIAGE_NOTE_MAX, isFailureTriageMarker, classifyFailureNote, summarizeFailureTriage,
  buildFailureTriageFeedbackComment, parseFailureTriageFeedbackComment, type FailureNote, type FailureTriageClassification, type FailureTriageFeedbackRecord,
} from './failureTriage.js';
export { classifyByRules, FAILURE_TRIAGE_RULES_VERSION, FAILURE_TRIAGE_PRECEDENCE, FAILURE_TRIAGE_RULE_IDS } from './failureTriageRules.js';
export { normalizeFailureText, failureEvidenceText, FAILURE_TRIAGE_EVIDENCE_VERSION } from './failureTriageEvidence.js';
export { recordFailureTriageFeedback, failureTriageHistory, getFailureTriageSource } from './ops/failureTriage.js';

import { openDb, type DB } from './db.js';
import { runMigrations } from './migrate.js';
import { getVersion } from './version.js';
import { createTask } from './ops/createTask.js';
import { importTask, type ImportTaskInput } from './ops/importTask.js';
import { updateTask } from './ops/updateTask.js';
import { deleteTask } from './ops/deleteTask.js';
import { archiveTask, unarchiveTask, archiveDoneTasks } from './ops/archiveTask.js';
import { listTasks } from './ops/listTasks.js';
import { getTask } from './ops/getTask.js';
import { addTaskDependency, removeTaskDependency } from './ops/taskDependencies.js';
import { claimNextTask, type ClaimOptions } from './ops/claimNextTask.js';
import { addComment } from './ops/addComment.js';
import { submitResult } from './ops/submitResult.js';
import { updateStatus } from './ops/updateStatus.js';
import { releaseClaim } from './ops/releaseClaim.js';
import { restartTask } from './ops/restartTask.js';
import { reserveRetry, settleRetry, reconcileRetry, reconcileAbandonedRetryReservations, recordRetryFailure, getRetryBudget, resetRetryBudget } from './ops/retry.js';
import { reserveExecution, reconcileExecutions, touchExecution, getCurrentExecution } from './ops/execution.js';
import { executionById } from './repo/execution.js';
import { addPrFeedback, type AddPrFeedbackInput } from './ops/addPrFeedback.js';
import { applyFeedbackFix } from './ops/applyFeedbackFix.js';
import { reviewApprove } from './ops/reviewApprove.js';
import { getDelivery, beginDelivery, recordDeliveryCheck, recordDeliveryCheckFailure, completeDelivery, failDelivery, type DeliveryFailureReason, type DeliveryCheckFailureInput } from './ops/delivery.js';
import type { DeliveryObservation } from './repo/delivery.js';
import { resolveOriginUrl } from './remote.js';
import { observeRevision, issueRevisionReadTicket, type RevisionObservationInput } from './ops/observeRevision.js';
import { remoteBranchHead, type RemoteHead } from './git.js';
import { resolveGitAuth } from './gitAuth.js';
import { listCredentialHealth, recordCredentialCheck, type CredentialCheck, type CredentialHealthView } from './credentialHealth.js';
import { probeCredential } from './probeCredential.js';
import { getWorkspacePat } from './repo/workspaces.js';
import { getGlobalPrompts, setGlobalPrompts, resolveAgentPrompt } from './agentPrompts.js';
import type { AgentPromptKey } from './agentPrompts.js';
import { reviewPrReviewed } from './ops/reviewPrReviewed.js';
import { reviewRequestChanges } from './ops/reviewRequestChanges.js';
import { analyticsRows } from './ops/analyticsRows.js';
import { spendByDay } from './ops/spendByDay.js';
import { addTaskMetrics } from './ops/addTaskMetrics.js';
import { recordVerification, latestVerification } from './ops/verification.js';
import { addAttachment } from './ops/addAttachment.js';
import { deleteAttachment } from './ops/deleteAttachment.js';
import { getAttachment } from './ops/getAttachment.js';
import { createWorkspace } from './ops/createWorkspace.js';
import { updateWorkspace } from './ops/updateWorkspace.js';
import { listWorkspaces } from './ops/listWorkspaces.js';
import { getWorkspace } from './ops/getWorkspace.js';
import { createUser, createApiToken, authenticateToken } from './ops/auth.js';
import { reportProgress, touchAgentSession, endAgentSession, listLiveAgents } from './ops/agentSession.js';
import { appendTranscript, saveTranscript, getTranscript, type AppendTranscriptInput, type SaveTranscriptInput } from './ops/transcript.js';
import { attachVisualization, getVisualization, getVisualizationHtml, type AttachVisualizationInput } from './ops/visualization.js';
import { recordSupervisorHeartbeat, listSupervisors } from './ops/supervisorHeartbeat.js';
import type { UpsertSupervisor } from './repo/supervisors.js';
import { activitySince, latestActivityId } from './repo/activity.js';
import { recentTokenMetrics } from './repo/metrics.js';
import { getKv, setKv } from './repo/kv.js';
import { captureNotifications, listAttentionOccurrences, listOpenAttention, listNotificationOutbox, listAllNotificationOutbox, settleNotificationOutbox, resolveAttention, snoozeAttention } from './ops/notifications.js';
import { getIntakeSettings, setIntakeSettings } from './ops/intakeSettings.js';
import { recordIntakeAssessment, beginIntakeAssessment, intakeHistory, overrideIntake, queueWithIntakeAcknowledgment, intakeRuntimeSettings } from './ops/intake.js';
import { getEngineSettings, setEngineSettings } from './engineSettings.js';
import { getAgentModels, setAgentModels, getAgentModelDefaults, reportAgentModelDefaults } from './agentModels.js';
import { getModelPrices, setModelPrices } from './modelPrices.js';
import { estimatePastCosts } from './ops/estimatePastCosts.js';
import { recordFailureTriageFeedback, failureTriageHistory, getFailureTriageSource } from './ops/failureTriage.js';
import { nowIso } from './time.js';
import type { ExpectedRevision, SubmissionSummary } from './types.js';
import type { GitAuth } from './gitAuth.js';
import type { Status, Actor, CreateTaskInput, UpdateTaskInput, SubmitResultInput, CreateWorkspaceInput, UpdateWorkspaceInput, AddTaskMetricsInput, RecordVerificationInput, AddAttachmentInput, DeliveryProvider, RetryOperation, AddCommentInput, FailureTriageFeedbackInput, CaptureNotificationsInput, SettleNotificationInput } from './types.js';

export interface CoreOptions {
  /** Injectable origin-URL resolver for the approve→delivering routing (tests pass a fake;
   *  production defaults to shelling `git remote get-url origin` — see remote.ts). */
  resolveOrigin?: ((repoPath: string) => string | null) | undefined;
  /** Keep HTTP adapters strict: only the request's executionId may fence a mutation. */
  autoFence?: boolean | undefined;
  /** Injectable approve-time head observation (tests pass a fake; production runs `git ls-remote`). */
  resolveRemoteHead?: ((repoPath: string, branch: string, auth: GitAuth | null) => Promise<RemoteHead>) | undefined;
  /** Injectable credential probe (tests pass a fake; production runs `git ls-remote` — probeCredential.ts). */
  probeCredential?: ((auth: GitAuth) => Promise<CredentialCheck>) | undefined;
}

/** Bind every op to a single DB handle — the surface the mcp/web adapters consume. */
export function createCore(db: DB, opts: CoreOptions = {}) {
  const resolveOrigin = opts.resolveOrigin ?? resolveOriginUrl;
  const resolveRemoteHead = opts.resolveRemoteHead ?? remoteBranchHead;
  // Keep the public in-process facade as ergonomic as the HTTP client: once a claim returns an
  // execution identity, subsequent mutations from that same facade are fenced automatically.
  // Raw ops still require callers to pass the identity, which keeps the DB boundary strict.
  const autoFence = opts.autoFence ?? true;
  const executionIds = new Map<string, string>();
  const fenced = <T extends { executionId?: string | undefined }>(key: string, input: T): T => {
    if (!autoFence || input.executionId !== undefined) return input;
    const executionId = executionIds.get(key);
    if (executionId === undefined) return input;
    // Only a LIVE cached fence is ergonomic. Once it settled (submit, release, reconcile) replaying
    // it would turn this facade's own later claim-less calls into stale-execution errors.
    const state = executionById(db, executionId)?.state;
    if (state !== 'reserved' && state !== 'running') {
      executionIds.delete(key);
      return input;
    }
    return { ...input, executionId };
  };
  return {
    createTask: (input: CreateTaskInput) => createTask(db, input),
    /** Supervisor-side import from an external tracker (ADO work items): idempotent create + queue. */
    importTask: (input: ImportTaskInput) => importTask(db, input),
    updateTask: (key: string, fields: UpdateTaskInput) => updateTask(db, key, fields),
    deleteTask: (key: string) => deleteTask(db, key),
    archiveTask: (key: string) => archiveTask(db, key),
    unarchiveTask: (key: string) => unarchiveTask(db, key),
    archiveDoneTasks: (opts: { workspace?: string | undefined } = {}) => archiveDoneTasks(db, opts),
    listTasks: (opts: { status?: Status | undefined; workspace?: string | undefined; archived?: boolean | undefined } = {}) => listTasks(db, opts),
    getTask: (key: string) => getTask(db, key),
    addTaskDependency: (dependentKey: string, dependencyKey: string) => addTaskDependency(db, dependentKey, dependencyKey),
    removeTaskDependency: (dependentKey: string, dependencyKey: string) => removeTaskDependency(db, dependentKey, dependencyKey),
    claimNextTask: (opts?: ClaimOptions) => {
      const claim = claimNextTask(db, opts);
      if (claim) executionIds.set(claim.key, claim.executionId);
      return claim;
    },
    reserveExecution: (key: string, input: { operation: string; maxAttempts: number; owner?: string | null; startImmediately?: boolean }) => reserveExecution(db, key, input),
    reconcileExecutions: (graceMs: number) => reconcileExecutions(db, graceMs),
    touchExecution: (id: string) => touchExecution(db, id),
    getCurrentExecution: (key: string) => getCurrentExecution(db, key),
    createWorkspace: (input: CreateWorkspaceInput) => createWorkspace(db, input),
    updateWorkspace: (name: string, input: UpdateWorkspaceInput) => updateWorkspace(db, name, input),
    listWorkspaces: () => listWorkspaces(db),
    getWorkspace: (name: string) => getWorkspace(db, name),
    /** The git auth (http.extraheader against a bare origin) for a workspace, or null — used by
     *  the dispatcher (worker git env) and the MCP submit-verify. Resolves DB PAT → env → null. */
    resolveGitAuth: (workspace: string) => resolveGitAuth(db, workspace, { env: process.env, resolveOrigin }),
    /** Recorded git-credential health per workspace (the board banner + the implementation claim hold). */
    listCredentialHealth: () => listCredentialHealth(db),
    /** Probe a workspace's managed git credential now and record the result; null when it has none
     *  (ambient/ssh auth). A PAT replaced while the probe ran keeps its fresh, unchecked state. */
    checkCredential: async (workspace: string): Promise<CredentialHealthView | null> => {
      getWorkspace(db, workspace); // NotFoundError for an unknown workspace
      const auth = resolveGitAuth(db, workspace, { env: process.env, resolveOrigin });
      if (!auth) return null;
      const check = await (opts.probeCredential ?? probeCredential)(auth);
      if (resolveGitAuth(db, workspace, { env: process.env, resolveOrigin })?.configValue !== auth.configValue) return null;
      recordCredentialCheck(db, workspace, check);
      return listCredentialHealth(db).find((v) => v.workspace === workspace) ?? null;
    },
    /** The raw stored PAT for a workspace, or null (watcher REST credential). Secret — never serialize. */
    getWorkspacePat: (workspace: string) => getWorkspacePat(db, workspace),
    /** Global default agent system prompts (app_kv) and the effective (override → global) resolver. */
    getGlobalPrompts: () => getGlobalPrompts(db),
    setGlobalPrompts: (partial: Record<string, string | null | undefined>) => setGlobalPrompts(db, partial),
    resolveAgentPrompt: (key: AgentPromptKey, workspace: string) => resolveAgentPrompt(db, key, workspace),
    createUser: (input: { email: string; displayName?: string; oidcSubject?: string | null; isSystem?: boolean }) => createUser(db, input),
    createApiToken: (input: { label: string; userId?: number | null; isService?: boolean; isSupervisor?: boolean }) => createApiToken(db, input),
    authenticateToken: (rawToken: string) => authenticateToken(db, rawToken),
    reportProgress: (key: string, input: { message: string; tokensIn?: number; tokensOut?: number; executionId?: string }) => reportProgress(db, key, fenced(key, input)),
    touchAgentSession: (key: string) => touchAgentSession(db, key),
    endAgentSession: (key: string) => endAgentSession(db, key),
    listLiveAgents: () => listLiveAgents(db),
    appendTranscript: (key: string, input: AppendTranscriptInput) => appendTranscript(db, key, fenced(key, input)),
    saveTranscript: (key: string, input: SaveTranscriptInput) => saveTranscript(db, key, fenced(key, input)),
    getTranscript: (key: string) => getTranscript(db, key),
    attachVisualization: (key: string, input: AttachVisualizationInput) => attachVisualization(db, key, fenced(key, input)),
    getVisualization: (key: string) => getVisualization(db, key),
    getVisualizationHtml: (key: string) => getVisualizationHtml(db, key),
    recordSupervisorHeartbeat: (input: UpsertSupervisor) => recordSupervisorHeartbeat(db, input),
    listSupervisors: () => listSupervisors(db),
    activitySince: (sinceId: number, limit?: number) => activitySince(db, sinceId, limit),
    latestActivityId: () => latestActivityId(db),
    getEngineSettings: () => getEngineSettings(db),
    setEngineSettings: (partial: unknown) => setEngineSettings(db, partial),
    /** Board-editable per-role engine/model/effort (global + per-workspace); supervisors read it every tick. */
    getAgentModels: () => getAgentModels(db),
    setAgentModels: (doc: unknown) => setAgentModels(db, doc),
    /** Supervisors' config-file model defaults, reported so the board can show them. */
    getAgentModelDefaults: () => getAgentModelDefaults(db),
    reportAgentModelDefaults: (report: unknown) => { reportAgentModelDefaults(db, report); },
    /** Board-editable USD-per-1M-token prices; the OTLP receiver prices Codex usage with them. */
    getModelPrices: () => getModelPrices(db),
    /** Latest OTel usage rows (newest first) — the live Telemetry feed restores these on a restart. */
    recentTokenMetrics: (limit: number) => recentTokenMetrics(db, limit),
    setModelPrices: (prices: unknown) => setModelPrices(db, prices),
    /** Price usage recorded before its model had a price, as an estimate (see ops/estimatePastCosts.ts). */
    estimatePastCosts: () => estimatePastCosts(db, getModelPrices(db)),
    getKv: (key: string) => getKv(db, key),
    setKv: (key: string, value: string) => setKv(db, key, value),
    captureNotifications: (input: CaptureNotificationsInput) => captureNotifications(db, input),
    listAttentionOccurrences: () => listAttentionOccurrences(db),
    listOpenAttention: (opts: { taskKey?: string | undefined } = {}) => listOpenAttention(db, opts),
    listNotificationOutbox: (now?: string, limit?: number) => listNotificationOutbox(db, now, limit),
    listAllNotificationOutbox: () => listAllNotificationOutbox(db),
    settleNotificationOutbox: (id: number, input: SettleNotificationInput) => settleNotificationOutbox(db, id, input),
    resolveAttention: (id: number) => resolveAttention(db, id),
    snoozeAttention: (id: number, until: string) => snoozeAttention(db, id, until),
    addComment: (key: string, input: AddCommentInput) => addComment(db, key, fenced(key, input)),
    submitResult: (key: string, input: SubmitResultInput) => submitResult(db, key, fenced(key, input)),
    updateStatus: (key: string, status: Status, actor: Actor, actorUserId: number | null = null, note?: string, executionId?: string, expected?: ExpectedRevision | null) => updateStatus(db, key, status, actor, nowIso, actorUserId, note, fenced(key, { executionId }).executionId, expected ?? null),
    releaseClaim: (key: string, now?: () => string, executionId?: string) => releaseClaim(db, key, now, fenced(key, { executionId }).executionId),
    restartTask: (key: string, actorUserId: number | null = null) => restartTask(db, key, actorUserId),
    reserveRetry: (key: string, input: { operation: RetryOperation; maxAttempts: number }) => reserveRetry(db, key, input),
    settleRetry: (id: string, input: { state: 'running' | 'succeeded' | 'failed' | 'cancelled'; reason?: string | undefined }) => settleRetry(db, id, input),
    reconcileRetry: (id: string, input: { actualKey: string; operation: RetryOperation; maxAttempts: number }) => reconcileRetry(db, id, input),
    reconcileAbandonedRetryReservations: (graceMs: number) => reconcileAbandonedRetryReservations(db, graceMs),
    recordRetryFailure: (key: string, input: { operation: RetryOperation; maxAttempts: number; attempt: number; reason: string }) => recordRetryFailure(db, key, input),
    getRetryBudget: (key: string, operation: RetryOperation) => getRetryBudget(db, key, operation),
    resetRetryBudget: (key: string, operation: RetryOperation, maxAttempts: number, reason?: string) => resetRetryBudget(db, key, operation, maxAttempts, reason),
    /** Delivering-feedback loop: attach a human's PR-review comment (trigger for the evaluator),
     *  and pull the task back to queued to apply a warranted verdict (composed feedback for the worker). */
    addPrFeedback: (key: string, input: AddPrFeedbackInput) => addPrFeedback(db, key, input),
    applyFeedbackFix: (key: string, actorUserId: number | null = null) => applyFeedbackFix(db, key, actorUserId),
    reviewApprove: (key: string, actorUserId: number | null = null, overrideReason?: string | null, expected?: ExpectedRevision | null) => reviewApprove(db, key, nowIso, actorUserId, resolveOrigin, overrideReason ?? null, expected ?? null),
    observeRevision: (key: string, input: RevisionObservationInput) => observeRevision(db, key, input),
    /** The git adapter's approve-time refresh: observe the current implementation submission's
     *  branch head on origin (outside any transaction) and record it — a later push then reads
     *  stale, an unreachable origin reads unknown. No-op for doc stages / unresolved revisions.
     *  It takes a read ticket before reading, like every reader: the one that started last wins. */
    refreshRevision: async (key: string): Promise<SubmissionSummary | null> => {
      const task = getTask(db, key);
      const sub = task.submission ?? null;
      if (!sub || sub.stage !== 'implementation' || sub.headSha === null || task.branch === null) return sub;
      const ticket = issueRevisionReadTicket(db, key, sub.id);
      if (!ticket) return getTask(db, key).submission ?? null;
      const readStartedAt = nowIso();
      const head = await resolveRemoteHead(task.repoPath, task.branch, resolveGitAuth(db, task.workspace, { env: process.env, resolveOrigin }));
      return observeRevision(db, key, { submissionId: sub.id, headSha: head.headSha, source: 'git', error: head.error, readTicket: ticket.ticket, readStartedAt });
    },
    /** A read ticket for the task's current submission: the watcher takes one before each provider poll. */
    issueRevisionReadTicket: (key: string, submissionId?: number) => issueRevisionReadTicket(db, key, submissionId),
    getDelivery: (key: string) => getDelivery(db, key),
    beginDelivery: (key: string, seed: { provider: DeliveryProvider; branch: string; prUrl?: string | null }) => beginDelivery(db, key, seed),
    recordDeliveryCheckFailure: (key: string, input: DeliveryCheckFailureInput) => recordDeliveryCheckFailure(db, key, input),
    recordDeliveryCheck: (key: string, obs: DeliveryObservation) => recordDeliveryCheck(db, key, obs),
    completeDelivery: (key: string, note: string, expectedStateChangedAt?: string) => completeDelivery(db, key, note, expectedStateChangedAt),
    failDelivery: (key: string, input: { reason: DeliveryFailureReason; detail: string; body?: string | undefined; expectedStateChangedAt?: string | undefined }) => failDelivery(db, key, input),
    reviewPrReviewed: (key: string, input: { review?: string | undefined; actorUserId?: number | null }) => reviewPrReviewed(db, key, input),
    reviewRequestChanges: (key: string, input: { feedback: string; actorUserId?: number | null }) => reviewRequestChanges(db, key, input),
    analyticsRows: () => analyticsRows(db),
    spendByDay: (opts: { month?: string | undefined; workspace?: string | undefined } = {}) => spendByDay(db, opts),
    addTaskMetrics: (key: string, input: AddTaskMetricsInput) => addTaskMetrics(db, key, fenced(key, input)),
    /** Runner verification records (migration #33): one per verify-command run of a live execution. */
    recordVerification: (key: string, input: RecordVerificationInput) => recordVerification(db, key, input),
    latestVerification: (key: string, executionId: string) => latestVerification(db, key, executionId),
    addAttachment: (key: string, input: AddAttachmentInput) => addAttachment(db, key, input),
    deleteAttachment: (id: number) => deleteAttachment(db, id),
    getAttachment: (id: number) => getAttachment(db, id),
    getVersion: () => getVersion(db),
    getIntakeSettings: () => getIntakeSettings(db),
    setIntakeSettings: (input: unknown) => setIntakeSettings(db, input),
    recordIntakeAssessment: (key: string, input: unknown) => recordIntakeAssessment(db, key, input),
    beginIntakeAssessment: (key: string, revision: string, maxAttempts: number) => beginIntakeAssessment(db, key, revision, maxAttempts),
    intakeHistory: (key: string) => intakeHistory(db, key),
    overrideIntake: (key: string, input: { expectedRevision: string; reason?: string | undefined; actorUserId?: number | null }) => overrideIntake(db, key, input),
    queueWithIntakeAcknowledgment: (key: string, input: { expectedRevision?: string | undefined; reason?: string | undefined; actorUserId?: number | null } = {}) => queueWithIntakeAcknowledgment(db, key, input),
    intakeRuntimeSettings: () => intakeRuntimeSettings(db),
    /** Advisory failure triage (human ops; the label itself is derived on Task.failureTriage). */
    recordFailureTriageFeedback: (key: string, input: FailureTriageFeedbackInput & { actorUserId?: number | null }) => recordFailureTriageFeedback(db, key, input),
    failureTriageHistory: (key: string, opts: { beforeId?: number | undefined; limit?: number | undefined } = {}) => failureTriageHistory(db, key, opts),
    getFailureTriageSource: (key: string, activityId: number) => getFailureTriageSource(db, key, activityId),
  };
}
export type Core = ReturnType<typeof createCore>;

/** Open + migrate a DB and return a bound Core — the one-call entry for adapters. */
export function openCore(path: string, opts: CoreOptions = {}): Core {
  const db = openDb(path);
  runMigrations(db);
  return createCore(db, opts);
}
