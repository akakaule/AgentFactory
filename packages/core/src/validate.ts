import { z } from 'zod';
import { ValidationError } from './errors.js';

const nonEmpty = z.string().trim().min(1);
const workspaceSlug = z
  .string()
  .max(64, 'workspace name must be at most 64 characters')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');

export const createTaskSchema = z.object({
  title: nonEmpty, spec: nonEmpty, acceptanceCriteria: nonEmpty, workspace: workspaceSlug.optional(),
});
export const createWorkspaceSchema = z.object({ name: workspaceSlug, repoPath: nonEmpty });
export const updateTaskSchema = z
  .object({ title: nonEmpty.optional(), spec: nonEmpty.optional(), acceptanceCriteria: nonEmpty.optional() })
  .refine((o) => Object.keys(o).length > 0, 'at least one field required');
export const submitResultSchema = z.object({
  summary: nonEmpty,
  links: z
    .array(z.object({ kind: z.enum(['branch', 'pr', 'worktree', 'log', 'url']), label: nonEmpty, url: nonEmpty }))
    .default([]),
});
export const commentSchema = z.object({ body: nonEmpty });
export const feedbackSchema = z.object({ feedback: nonEmpty });
export const taskMetricsSchema = z
  .object({
    model: nonEmpty.optional(),
    tokensIn: z.number().int().nonnegative().optional(),
    tokensOut: z.number().int().nonnegative().optional(),
    costUsd: z.number().nonnegative().optional(),
    reportedBy: nonEmpty.optional(),
  })
  .refine(
    (o) => o.model !== undefined || o.tokensIn !== undefined || o.tokensOut !== undefined || o.costUsd !== undefined,
    'at least one metric field required (model, tokensIn, tokensOut, costUsd)',
  );

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}
