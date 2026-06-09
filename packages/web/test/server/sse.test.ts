import { describe, it, expect } from 'vitest';
import { openCore } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

// read decoded chunks for up to `ms`, then cancel the reader so the server loop can exit
async function collect(res: Response, ms: number): Promise<string> {
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let text = '';
  let stop = false;
  const timer = setTimeout(() => { stop = true; }, ms);
  try {
    while (!stop) {
      const race = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), ms)),
      ]);
      if (race.done) break;
      if (race.value) text += dec.decode(race.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
  }
  return text;
}

// Read chunks from an already-acquired reader for up to `ms`, then cancel.
async function collectReader(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  ms: number,
): Promise<string> {
  const dec = new TextDecoder();
  let text = '';
  let stop = false;
  const timer = setTimeout(() => { stop = true; }, ms);
  try {
    while (!stop) {
      const race = await Promise.race([
        reader.read(),
        new Promise<{ done: true; value?: undefined }>((r) => setTimeout(() => r({ done: true }), ms)),
      ]);
      if (race.done) break;
      if (race.value) text += dec.decode(race.value, { stream: true });
    }
  } finally {
    clearTimeout(timer);
  }
  return text;
}

describe('SSE /events', () => {
  it('emits an initial version event', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { sseIntervalMs: 20 });
    const res = await app.request('/events');
    expect(res.headers.get('content-type') ?? '').toContain('text/event-stream');
    const text = await collect(res, 150);
    expect(text).toContain('event: version');
  });

  it('pushes a new version event after a mutation, with a higher value', async () => {
    const core = openCore(':memory:');
    const app = buildApp(core, { sseIntervalMs: 20 });
    const res = await app.request('/events');

    // Acquire ONE reader for the entire test lifetime
    const reader = res.body!.getReader();

    // Drain initial events (initial version + a couple of pings) for ~80ms
    await collectReader(reader, 80);

    // Mutate: this advances getVersion()
    core.createTask({ title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    // Collect what comes after the mutation for ~200ms
    const after = await collectReader(reader, 200);

    // Release the stream so the server loop can exit
    await reader.cancel().catch(() => {});

    // A version event carrying the new (non-empty) token should appear after the mutation
    expect(after).toContain('event: version');
    const v = core.getVersion();
    expect(v).not.toBe('');
    expect(after).toContain(v);
  });
});
