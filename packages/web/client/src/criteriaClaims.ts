import type { CriterionClaim } from './types.js';

/** Client-side reader for the `criteria-claims/v1` marker comment (mirrors core's
 *  src/criteriaClaims.ts — the client can't import core's runtime). */

const isCriteriaClaims = (b: string) => /^criteria-claims\/v1\b/i.test(b.trimStart());

/** The claims in a marker comment, or null when the body is unmarked or malformed. */
export function parseCriteriaClaims(body: string): CriterionClaim[] | null {
  if (!isCriteriaClaims(body)) return null;
  const fence = /```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/i.exec(body);
  if (!fence) return null;
  try {
    const o = JSON.parse(fence[1]!) as { claims?: unknown };
    if (!Array.isArray(o.claims)) return null;
    const claims = o.claims.filter((c): c is CriterionClaim =>
      !!c && typeof c === 'object' && typeof (c as CriterionClaim).id === 'string' && typeof (c as CriterionClaim).claim === 'string');
    return claims.length === o.claims.length ? claims : null;
  } catch {
    return null;
  }
}
