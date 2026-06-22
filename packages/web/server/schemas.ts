import { z } from 'zod';
export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done', 'blocked']);
export const workspaceSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');
export const workspaceBody = z.object({ name: workspaceSlug, repoPath: z.string().min(1) });
// PATCH: each field may be a string (set), null (clear), or absent (leave). ≥1 field enforced by core.
export const workspaceUpdateBody = z
  .object({ policy: z.string().nullable().optional(), verifyCommand: z.string().nullable().optional() })
  .refine((o) => o.policy !== undefined || o.verifyCommand !== undefined, 'at least one field required (policy, verifyCommand)');
export const StageEnum = z.enum(['description', 'plan', 'implementation']);
export const createBody = z.object({
  title: z.string().min(1), spec: z.string().min(1),
  acceptanceCriteria: z.string().min(1).optional(), // required unless stage 'description' — core's ValidationError → 400
  stage: StageEnum.optional(),
  workspace: z.string().min(1).optional(),
});
export const updateBody = z.object({ title: z.string().min(1).optional(), spec: z.string().min(1).optional(), acceptanceCriteria: z.string().min(1).optional() });
export const commentBody = z.object({ body: z.string().min(1) });
export const statusBody = z.object({ status: StatusEnum, note: z.string().optional() });
export const feedbackBody = z.object({ feedback: z.string().min(1) });
export const listQuery = z.object({ status: StatusEnum.optional(), workspace: z.string().min(1).optional(), archived: z.enum(['true', 'false']).optional() });
export const archiveAllBody = z.object({ workspace: z.string().min(1).optional() });
export const attachmentBody = z.object({
  filename: z.string().min(1),
  mime: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
  dataBase64: z.string().min(1),
});
export const metricsBody = z.object({
  model: z.string().min(1).optional(),
  tokensIn: z.number().int().nonnegative().optional(),
  tokensOut: z.number().int().nonnegative().optional(),
  costUsd: z.number().nonnegative().optional(),
  reportedBy: z.string().min(1).optional(),
}); // ≥1 metric field is enforced by core's ValidationError → 400
