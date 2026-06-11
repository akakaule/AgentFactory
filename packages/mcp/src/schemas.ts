import { z } from 'zod';

export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done', 'blocked']);
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
