import { z } from 'zod';

export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'delivering', 'done', 'blocked']);
// The subset an agent may target via update_status. 'delivering' is deliberately excluded: that
// state (and its edges) belong to the watcher supervisor, which drives core directly — the MCP
// surface must never let an agent move a task into or out of delivery verification.
export const AgentStatusEnum = StatusEnum.exclude(['delivering']);
export const LinkSchema = z.object({
  kind: z.enum(['branch', 'pr', 'worktree', 'log', 'url']),
  label: z.string().min(1),
  url: z.string().url(),
});
export const taskKey = z.string().regex(/^AF-\d+$/, 'key must look like AF-123');
export const MetricsSchema = z.object({
  model: z.string().min(1).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
});
