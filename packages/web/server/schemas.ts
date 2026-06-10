import { z } from 'zod';
export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done', 'blocked']);
export const workspaceSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');
export const workspaceBody = z.object({ name: workspaceSlug, repoPath: z.string().min(1) });
export const createBody = z.object({
  title: z.string().min(1), spec: z.string().min(1), acceptanceCriteria: z.string().min(1),
  workspace: z.string().min(1).optional(),
});
export const updateBody = z.object({ title: z.string().min(1).optional(), spec: z.string().min(1).optional(), acceptanceCriteria: z.string().min(1).optional() });
export const commentBody = z.object({ body: z.string().min(1) });
export const statusBody = z.object({ status: StatusEnum });
export const feedbackBody = z.object({ feedback: z.string().min(1) });
export const listQuery = z.object({ status: StatusEnum.optional(), workspace: z.string().min(1).optional() });
