import type { TaskDetail } from '@agentfactory/core';

export type { Task, TaskDetail, Activity, Link, Status, Stage, TaskKind, Actor, ActivityType, LinkKind, Workspace, TaskMetricsView, Attachment, AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity, FailureSummary, DeliverySummary, DeliveryProvider, DeliveryPrState, DeliveryChecksState, DeliveryFailingCheck, AgentSessionView, AgentMilestone, SupervisorView, SupervisorKind, TranscriptEngine, TranscriptBlockBase, TranscriptBlock, TranscriptResponse, AgentPromptKey, AgentPrompts } from '@agentfactory/core';

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
  /** Cache-hit portion already included in `tokensIn` (a breakdown, not additive). */
  tokensCached: number;
  tokensOut: number;
  costUsd: number | null;
}

/** GET /api/tasks/:key — a TaskDetail plus the server-computed create-PR deep link, present only
 *  while a delivering task's watcher poll reports no PR on the git host. */
export type TaskDetailView = TaskDetail & { createPrUrl?: string };
