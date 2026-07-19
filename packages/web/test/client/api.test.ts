import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { api, REQUEST_TIMEOUT_MS } from '../../client/src/api.js';

// Regression: when the browser's per-host connection pool is starved (long-lived SSE streams
// across tabs / stale sockets after a server restart), a fetch is queued but never sent. An
// unbounded request then hangs forever and leaves the UI stuck (e.g. a "Creating…" button
// that never returns). req() must abort after REQUEST_TIMEOUT_MS and reject so the form can
// recover instead of spinning indefinitely.
describe('api request timeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('rejects with a timeout error when a request never resolves', async () => {
    // A fetch that only ever settles when its abort signal fires — mirrors a real stuck request.
    global.fetch = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
    })) as unknown as typeof fetch;

    const pending = api.createTask({ title: 'T', spec: 'S' });
    const assertion = expect(pending).rejects.toThrow(/timed out/i);

    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
    await assertion;
  });

  it('resolves normally and clears the timer when the request completes in time', async () => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({ key: 'AF-1' }), {
      status: 201, headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

    await expect(api.createTask({ title: 'T', spec: 'S' })).resolves.toMatchObject({ key: 'AF-1' });
  });
});

describe('task dependency API', () => {
  beforeEach(() => {
    global.fetch = vi.fn(async () => new Response(JSON.stringify({
      key: 'AF-2',
      dependencies: [],
      dependents: [],
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;
  });

  afterEach(() => vi.restoreAllMocks());

  it('adds a dependency with both task keys URL-encoded', async () => {
    await api.addTaskDependency('AF 2/α', 'AF/1 ?');

    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks/AF%202%2F%CE%B1/dependencies/AF%2F1%20%3F',
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('removes a dependency with both task keys URL-encoded', async () => {
    await api.removeTaskDependency('AF 2/α', 'AF/1 ?');

    expect(fetch).toHaveBeenCalledWith(
      '/api/tasks/AF%202%2F%CE%B1/dependencies/AF%2F1%20%3F',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });
});
