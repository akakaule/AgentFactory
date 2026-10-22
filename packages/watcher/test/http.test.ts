import { describe, it, expect } from 'vitest';
import { makeFetchJson } from '../src/http.js';

const jsonResponse = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });

describe('makeFetchJson', () => {
  it('passes an abort signal on every request — a hung provider cannot wedge the tick', async () => {
    let seenSignal: AbortSignal | undefined;
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seenSignal = init?.signal ?? undefined;
      return jsonResponse({ ok: true });
    }) as typeof fetch;

    await makeFetchJson(fetchImpl)('https://api.github.test/x', { headers: {} });

    expect(seenSignal).toBeInstanceOf(AbortSignal);
  });

  it('rejects when the request outlives the timeout', async () => {
    const fetchImpl = ((_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;

    await expect(makeFetchJson(fetchImpl, 20)('https://api.github.test/hang', { headers: {} }))
      .rejects.toThrow(/timeout|timed out/i);
  });

  it('sends a POST with a JSON body and content-type when asked (PR creation)', async () => {
    let seen: { method?: string | undefined; body?: unknown; contentType?: string | null } = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = { method: init?.method, body: init?.body, contentType: new Headers(init?.headers).get('content-type') };
      return jsonResponse({ number: 7 }, 201);
    }) as typeof fetch;

    const res = await makeFetchJson(fetchImpl)('https://api.github.test/pulls', {
      headers: { Accept: 'application/json' }, method: 'POST', body: JSON.stringify({ title: 't' }),
    });

    expect(res.status).toBe(201);
    expect(seen.method).toBe('POST');
    expect(seen.body).toBe('{"title":"t"}');
    expect(seen.contentType).toBe('application/json');
  });

  it('keeps a caller-set content-type (ADO work-item PATCH is application/json-patch+json)', async () => {
    let seen: { method?: string | undefined; contentType?: string | null } = {};
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      seen = { method: init?.method, contentType: new Headers(init?.headers).get('content-type') };
      return jsonResponse({ id: 1 }, 200);
    }) as typeof fetch;

    await makeFetchJson(fetchImpl)('https://dev.azure.test/wit/workitems/1', {
      headers: { 'Content-Type': 'application/json-patch+json' }, method: 'PATCH', body: '[]',
    });

    expect(seen.method).toBe('PATCH');
    expect(seen.contentType).toBe('application/json-patch+json');
  });

  it('lower-cases headers and tolerates a non-JSON body', async () => {
    const fetchImpl = (async () =>
      new Response('nope', { status: 502, headers: { 'X-RateLimit-Remaining': '0' } })) as typeof fetch;

    const res = await makeFetchJson(fetchImpl)('https://api.github.test/x', { headers: {} });

    expect(res.status).toBe(502);
    expect(res.headers['x-ratelimit-remaining']).toBe('0');
    expect(res.body).toBeNull();
  });
});
