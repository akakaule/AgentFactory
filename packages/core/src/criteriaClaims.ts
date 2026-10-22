/**
 * The `criteria-claims/v1` marker: the implementing agent's claim per acceptance criterion — how
 * the change meets it and which test proves it — submitted with the implementation result and
 * stored as one comment right after the `result` row (like the `verify:` attestation). The board
 * shows each claim next to what the reviewers found (docs/spec/2026-10-21-review-decision-panel-
 * design.md §4.3). The body is the marker line and a fenced JSON block: `{ "claims": [{ id, claim }] }`.
 */
import { z } from 'zod';
import type { CriterionClaim } from './types.js';

export const CRITERIA_CLAIMS_MARKER = 'criteria-claims/v1';
const MARKER = /^criteria-claims\/v1\b/i;

const claimsSchema = z.object({
  claims: z.array(z.object({ id: z.string().min(1), claim: z.string().min(1) }).strict()),
}).strict();

export function isCriteriaClaimsMarker(body: string): boolean {
  return MARKER.test(body.trimStart());
}

export function buildCriteriaClaimsComment(claims: CriterionClaim[]): string {
  return `${CRITERIA_CLAIMS_MARKER}\n\n\`\`\`json\n${JSON.stringify({ claims })}\n\`\`\``;
}

/** The claims in a marker comment, or null when the body is unmarked or malformed. */
export function parseCriteriaClaims(body: string): CriterionClaim[] | null {
  if (!isCriteriaClaimsMarker(body)) return null;
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(body);
  if (!fence) return null;
  try {
    const parsed = claimsSchema.safeParse(JSON.parse(fence[1]!));
    return parsed.success ? parsed.data.claims : null;
  } catch {
    return null;
  }
}
