export type { Task, TaskDetail, Activity, Link, Status, Stage, Actor, ActivityType, LinkKind, Workspace, TaskMetricsView, Attachment, AiReviewSummary, AiReviewFinding, AiReviewVerdict, AiReviewSeverity, AgentSessionView, AgentMilestone } from '@agentfactory/core';

/** One OTel token event from the live telemetry feed (GET /api/telemetry). Mirror of the
 *  server's TelemetryEvent — ephemeral, newest-first. `taskKey` null ⇒ arrived unattributed. */
export interface TelemetryEvent {
  seq: number;
  at: string;
  taskKey: string | null;
  workspace: string | null;
  worker: string | null;
  agent: 'claude-code' | 'codex';
  model: string | null;
  tokensIn: number;
  tokensOut: number;
  costUsd: number | null;
}
