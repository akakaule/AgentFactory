import { z } from 'zod';
import { ValidationError } from './errors.js';
import { ATTACHMENT_MIMES } from './types.js';

const nonEmpty = z.string().trim().min(1);
const workspaceSlug = z
  .string()
  .max(64, 'workspace name must be at most 64 characters')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');

const stageEnum = z.enum(['description', 'plan', 'implementation']);

export const createTaskSchema = z
  .object({
    title: nonEmpty, spec: nonEmpty,
    acceptanceCriteria: nonEmpty.optional(),
    stage: stageEnum.optional(),
    workspace: workspaceSlug.optional(),
  })
  .superRefine((o, ctx) => {
    // the description stage writes the acceptance criteria; every other entry point must bring them
    if (o.stage !== 'description' && o.acceptanceCriteria === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'acceptanceCriteria is required unless stage is description' });
  });
export const createWorkspaceSchema = z.object({ name: workspaceSlug, repoPath: nonEmpty });
export const updateTaskSchema = z
  .object({ title: nonEmpty.optional(), spec: nonEmpty.optional(), acceptanceCriteria: nonEmpty.optional() })
  .refine((o) => Object.keys(o).length > 0, 'at least one field required');
export const submitResultSchema = z.object({
  summary: nonEmpty,
  // stage deliverables; which are required/forbidden depends on the task's stage,
  // which the schema can't see — ops/submitResult.ts enforces the per-stage shape
  spec: nonEmpty.optional(),
  acceptanceCriteria: nonEmpty.optional(),
  plan: nonEmpty.optional(),
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

export const attachmentSchema = z.object({
  filename: nonEmpty,
  mime: z.enum(ATTACHMENT_MIMES),
  dataBase64: z.string(), // emptiness/size checked after decoding
});

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}
