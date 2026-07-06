import { z } from 'zod';
export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'delivering', 'done', 'blocked']);
export const workspaceSlug = z
  .string()
  .max(64)
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');
export const workspaceBody = z.object({ name: workspaceSlug, repoPath: z.string().min(1) });
// PATCH: each field may be a string (set), null (clear), or absent (leave). ≥1 field enforced by core.
// `pat` is the git-host credential (write-only — GET never returns it, only workspace.hasPat).
export const workspaceUpdateBody = z
  .object({ policy: z.string().nullable().optional(), verifyCommand: z.string().nullable().optional(), pat: z.string().nullable().optional() })
  .refine(
    (o) => o.policy !== undefined || o.verifyCommand !== undefined || o.pat !== undefined,
    'at least one field required (policy, verifyCommand, pat)',
  );
export const StageEnum = z.enum(['description', 'plan', 'implementation']);
const LinkKindEnum = z.enum(['branch', 'pr', 'worktree', 'log', 'url']);
export const createBody = z.object({
  title: z.string().min(1), spec: z.string().min(1),
  acceptanceCriteria: z.string().min(1).optional(), // required unless stage 'description' — core's ValidationError → 400
  stage: StageEnum.optional(),
  kind: z.enum(['code', 'pr-review']).optional(),    // default 'code'; 'pr-review' for an imported PR-review task
  links: z.array(z.object({ kind: LinkKindEnum, label: z.string().min(1), url: z.string().min(1) })).optional(),
  workspace: z.string().min(1).optional(),
});
export const updateBody = z.object({ title: z.string().min(1).optional(), spec: z.string().min(1).optional(), acceptanceCriteria: z.string().min(1).optional() });
export const commentBody = z.object({ body: z.string().min(1) });
export const statusBody = z.object({ status: StatusEnum, note: z.string().optional() });
export const feedbackBody = z.object({ feedback: z.string().min(1) });
// "Mark reviewed" for a pr-review: an optional review body captured for the PR (empty = closed with no comment).
export const prReviewedBody = z.object({ review: z.string().optional() });
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
