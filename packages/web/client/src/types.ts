export type { Task, TaskDetail, Activity, Link, Status, Stage, Actor, ActivityType, LinkKind, Workspace, TaskMetricsView, Attachment, AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity, FailureSummary, AgentSessionView, AgentMilestone } from '@agentfactory/core';

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
