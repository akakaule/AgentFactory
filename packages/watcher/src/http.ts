import type { FetchJson } from './types.js';

/** Hard ceiling per request. The tick awaits every provider call and `ticking` guards
 *  re-entry, so a single black-holed connection with no timeout would silently stop ALL
 *  delivering polls forever (heartbeat frozen included). */
export const HTTP_TIMEOUT_MS = 30_000;

/** Node's global fetch, folded to the providers' JSON shape (headers lower-cased by undici). */
export function makeFetchJson(fetchImpl: typeof fetch = fetch, timeoutMs: number = HTTP_TIMEOUT_MS): FetchJson {
  return async (url, init) => {
    const res = await fetchImpl(url, {
      method: init.method ?? 'GET',
      // a body is JSON unless the caller named its own type (ADO work-item PATCH is json-patch+json)
      headers: init.body !== undefined && !Object.keys(init.headers).some((h) => h.toLowerCase() === 'content-type')
        ? { ...init.headers, 'content-type': 'application/json' }
        : init.headers,
      ...(init.body !== undefined ? { body: init.body } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => { headers[k.toLowerCase()] = v; });
    let body: unknown = null;
    try { body = await res.json(); } catch { /* non-JSON error bodies are fine — status carries it */ }
    return { status: res.status, headers, body };
  };
}
