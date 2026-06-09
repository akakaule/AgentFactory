import { z } from 'zod';
export const StatusEnum = z.enum(['backlog', 'queued', 'in_progress', 'in_review', 'done', 'blocked']);
export const createBody = z.object({ title: z.string().min(1), spec: z.string().min(1), acceptanceCriteria: z.string().min(1) });
export const updateBody = z.object({ title: z.string().min(1).optional(), spec: z.string().min(1).optional(), acceptanceCriteria: z.string().min(1).optional() });
export const commentBody = z.object({ body: z.string().min(1) });
export const statusBody = z.object({ status: StatusEnum });
export const feedbackBody = z.object({ feedback: z.string().min(1) });
export const listQuery = z.object({ status: StatusEnum.optional() });
