import { z } from 'zod';
import { ValidationError } from './errors.js';

const nonEmpty = z.string().trim().min(1);

export const createTaskSchema = z.object({ title: nonEmpty, spec: nonEmpty, acceptanceCriteria: nonEmpty });
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

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues.map((i) => i.message).join('; '));
  return r.data;
}
