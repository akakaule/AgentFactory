import type { FetchResponse } from '../types.js';
import { ProviderHttpError } from './types.js';

/** Azure DevOps PAT auth header (`Basic base64(':' + pat)`). */
export const basicPat = (pat: string): string => `Basic ${Buffer.from(`:${pat}`).toString('base64')}`;

/**
 * Shared Azure DevOps response guard: `ok` statuses pass; 429 throws with a pause (Retry-After);
 * 203/401/403 are auth failures naming the PAT `scope` the call needs; anything else throws plainly.
 * ADO answers an unauthenticated/failed-PAT request with the Azure AD sign-in page and a 203
 * (Non-Authoritative Information), not a 401 — so 203/401/403 all mean "fix the PAT".
 */
export function azdoGuard(res: FetchResponse, url: string, scope: string, ok: readonly number[] = [200]): FetchResponse {
  if (ok.includes(res.status)) return res;
  const retryAfter = Number(res.headers['retry-after'] ?? NaN);
  if (res.status === 429) {
    throw new ProviderHttpError(`azdo 429 for ${url}`, 429, Date.now() + (Number.isFinite(retryAfter) ? retryAfter : 60) * 1000);
  }
  if (res.status === 203 || res.status === 401 || res.status === 403) {
    throw new ProviderHttpError(
      `azdo auth failed (${res.status}) — the PAT is missing, invalid, expired, or lacks ${scope} for this org/project: ${url}`,
      res.status,
    );
  }
  const detail = (res.body as { message?: unknown } | null)?.message;
  throw new ProviderHttpError(`azdo ${res.status} for ${url}${typeof detail === 'string' ? `: ${detail}` : ''}`, res.status);
}
