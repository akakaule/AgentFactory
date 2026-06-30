import { z } from 'zod';
import { ValidationError } from './errors.js';
import { ATTACHMENT_MIMES } from './types.js';

const nonEmpty = z.string().trim().min(1);
const workspaceSlug = z
  .string()
  .max(64, 'workspace name must be at most 64 characters')
  .regex(/^[a-z0-9][a-z0-9-]*$/, 'workspace name must be a lowercase slug (a-z, 0-9, dashes; starts alphanumeric)');

const stageEnum = z.enum(['description', 'plan', 'implementation']);

const linkInput = z.object({ kind: z.enum(['branch', 'pr', 'worktree', 'log', 'url']), label: nonEmpty, url: nonEmpty });

export const createTaskSchema = z
  .object({
    title: nonEmpty, spec: nonEmpty,
    acceptanceCriteria: nonEmpty.optional(),
    stage: stageEnum.optional(),
    kind: z.enum(['code', 'pr-review']).optional(), // default 'code'; 'pr-review' for an imported PR-review task
    links: z.array(linkInput).optional(),           // attached at creation (a PR-review task requires a branch link; pr link optional — see superRefine)
    workspace: workspaceSlug.optional(),
  })
  .superRefine((o, ctx) => {
    // the description stage writes the acceptance criteria; every other entry point must bring them
    if (o.stage !== 'description' && o.acceptanceCriteria === undefined)
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'acceptanceCriteria is required unless stage is description' });
    // a pr-review task's only functional input is the remote branch to review: the diff route and
    // reviewer fetch+diff `origin/<branch link label>`. Require that branch link at creation (the
    // `pr` link — a deep-link to the PR/MR page — stays optional context).
    if (o.kind === 'pr-review' && !(o.links ?? []).some((l) => l.kind === 'branch'))
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'a pr-review task requires a branch link (the remote branch to review)' });
  });
export const createWorkspaceSchema = z.object({ name: workspaceSlug, repoPath: nonEmpty });
// policy / verifyCommand: a trimmed non-empty string sets it, null clears it, absence leaves it.
// Empty/whitespace-only strings normalise to null so "save blank" clears rather than stores "".
const clearable = z
  .string()
  .transform((s) => (s.trim().length === 0 ? null : s.trim()))
  .nullable();
export const updateWorkspaceSchema = z
  .object({ policy: clearable.optional(), verifyCommand: clearable.optional() })
  .refine((o) => o.policy !== undefined || o.verifyCommand !== undefined, 'at least one field required (policy, verifyCommand)');
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
  verification: nonEmpty.optional(), // implementation stage: reported outcome of the workspace verify command

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
