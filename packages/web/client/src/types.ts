import type { TaskDetail, Workspace as CoreWorkspace, CiMode, EffectiveWorkspaceProfile, AdoSyncSettings, AgentModels, AgentModelDefaults, ModelCatalogEntry } from '@agentfactory/core';

export type { AdoSyncSettings } from '@agentfactory/core';
export type { CiMode, EffectiveWorkspaceProfile, WorkspaceDiagnosis, DiagnosticCheck, DiagnosticId, DiagnosticStatus } from '@agentfactory/core';
/** A workspace as GET /api/workspaces serves it: core's shape plus the board-only origin, for an
 *  Azure DevOps import the WIQL it runs, and the effective repository profile. Optional so older
 *  payloads/fixtures stay valid. */
export type Workspace = Omit<CoreWorkspace, 'adoSync' | 'baseBranch' | 'requiredChecks' | 'ciMode' | 'createPullRequests'> & {
  adoSync?: AdoSyncSettings | null;
  baseBranch?: string | null;
  requiredChecks?: string[] | null;
  ciMode?: CiMode | null;
  createPullRequests?: boolean | null;
  profile?: EffectiveWorkspaceProfile;
  remote?: { provider: 'github' } | { provider: 'azdo'; organization: string; project: string } | null;
  adoSyncWiql?: string | null;
};

export type { Task, TaskDetail, Activity, Link, Status, Stage, TaskKind, Actor, ActivityType, LinkKind, TaskMetricsView, Attachment, AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity, ReviewBrief, ReviewIssue, ReviewOpinion, ReviewCandidateRef, ReviewCriterionRow, ReviewHeadline, ReviewGroup, ReviewDispute, CriterionClaim, FailureSummary, DeliverySummary, DeliveryProvider, DeliveryPrState, DeliveryChecksState, DeliveryFailingCheck, AgentSessionView, AgentMilestone, SupervisorView, SupervisorKind, TranscriptEngine, TranscriptBlockBase, TranscriptBlock, TranscriptResponse, AgentPromptKey, AgentPrompts, AgentEngine, EngineSettings, IntakeSettings, IntakeSummary, IntakeAssessmentV1, FailureTriageCategory, FailureTriageSummary, FailureTriageFeedback, FailureTriageFeedbackInput, FailureTriageHistoryItem, FailureTriageHistoryPage, Effort, ModelCatalogEntry, ModelProfile, AgentModelStages, AgentModelLayer, WorkspaceModelLayer, AgentModels, ReportedProfile, ReportedRoles, AgentModelDefaults, ModelPrice, ModelPrices } from '@agentfactory/core';

/** GET/PUT /api/agent-models: the board's model settings, supervisors' file defaults, the catalogue. */
export interface AgentModelsView {
  settings: AgentModels;
  defaults: AgentModelDefaults;
  catalog: ModelCatalogEntry[];
}

/** One OTel token event from the live telemetry feed (GET /api/telemetry). Mirror of the
 *  server's TelemetryEvent — ephemeral, newest-first. Only task-attributed events are fed. */
export interface TelemetryEvent {
  seq: number;
  at: string;
  taskKey: string | null;
  workspace: string | null;
  worker: string | null;
  agent: 'claude-code' | 'codex';
  model: string | null;
  tokensIn: number;
  /** Cache-hit portion already included in `tokensIn` (a breakdown, not additive); null for an
   *  event restored after a board restart. */
  tokensCached: number | null;
  tokensOut: number;
  costUsd: number | null;
}

/** GET /api/tasks/:key — a TaskDetail plus the server-computed create-PR deep link, present only
 *  while a delivering task's watcher poll reports no PR on the git host. */
export type TaskDetailView = TaskDetail & { createPrUrl?: string };
