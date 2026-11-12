import { z } from 'zod';
import { ValidationError } from './errors.js';

/**
 * A structured question an agent asks when it blocks (`decision/v1`). It rides in the block's
 * status_change body after the one-line reason, as a final `decision/v1 {json}` line, so it is
 * derived from the activity log like every other marker and needs no migration. The board shows
 * the options; a human's answer comes back to the next session as a binding `feedback` activity.
 */
export const DECISION_MARKER = 'decision/v1';

export const decisionOptionSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,19}$/, 'option id must be a short lowercase slug'),
  label: z.string().trim().min(1).max(120),
  detail: z.string().trim().max(300).optional(),
});

export const decisionRequestSchema = z.object({
  question: z.string().trim().min(1).max(500),
  options: z.array(decisionOptionSchema).min(2).max(4),
  recommended: z.string().optional(),
}).superRefine((d, ctx) => {
  const ids = d.options.map((o) => o.id);
  if (new Set(ids).size !== ids.length) ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'option ids must be unique' });
  if (d.recommended !== undefined && !ids.includes(d.recommended))
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'recommended must name one of the option ids' });
});

export type DecisionOption = z.infer<typeof decisionOptionSchema>;
export type DecisionRequest = z.infer<typeof decisionRequestSchema>;

const MARKER_LINE = /(?:^|\n)decision\/v1 (\{.*\})\s*$/s;

/** A block note: the human-readable reason, then the decision marker line. Throws on an invalid decision. */
export function formatBlockNote(reason: string | undefined, decision: DecisionRequest): string {
  const parsed = decisionRequestSchema.safeParse(decision);
  if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join('; '));
  const d = parsed.data;
  const json = JSON.stringify({ question: d.question, options: d.options, ...(d.recommended ? { recommended: d.recommended } : {}) });
  return `${reason?.trim() || d.question}\n${DECISION_MARKER} ${json}`;
}

/** Split a block note into its reason and decision. A malformed marker yields no decision; its line is still dropped from the reason. */
export function parseBlockNote(body: string): { reason: string | null; decision: DecisionRequest | null } {
  const m = MARKER_LINE.exec(body);
  if (!m) return { reason: body.trim() || null, decision: null };
  const reason = body.slice(0, m.index).trim() || null;
  let decision: DecisionRequest | null = null;
  try {
    const parsed = decisionRequestSchema.safeParse(JSON.parse(m[1]!));
    if (parsed.success) decision = parsed.data;
  } catch { /* malformed JSON: no decision */ }
  return { reason, decision };
}
