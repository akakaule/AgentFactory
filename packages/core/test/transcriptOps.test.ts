import { describe, it, expect } from 'vitest';
import { makeTestDb } from './helpers.js';
import { createTask } from '../src/ops/createTask.js';
import { appendTranscript, saveTranscript, getTranscript } from '../src/ops/transcript.js';

const userLine = (uuid: string, text: string) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content: text }, uuid, timestamp: '2026-06-27T00:00:00.000Z' });

describe('transcript ops', () => {
  it('returns none for an unknown task and for a captured-nothing task', () => {
    const db = makeTestDb();
    expect(getTranscript(db, 'AF-999')).toMatchObject({ state: 'none', blocks: [] });
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });
    expect(getTranscript(db, t.key)).toMatchObject({ state: 'none' });
  });

  it('exposes a live tail on append, then a parsed persisted artifact on save (gzip round-trip)', () => {
    const db = makeTestDb();
    const t = createTask(db, { title: 'T', spec: 'S', acceptanceCriteria: 'A' });

    appendTranscript(db, t.key, { chunk: userLine('u1', 'hello') + '\n' });
    const live = getTranscript(db, t.key);
    expect(live.state).toBe('live');
    expect(live.blocks[0]).toMatchObject({ kind: 'text', text: 'hello' });

    const raw = [userLine('u1', 'hello'), userLine('u2', 'world')].join('\n') + '\n';
    saveTranscript(db, t.key, { raw, sessionId: 'sess-1' });
    const final = getTranscript(db, t.key);
    expect(final.state).toBe('final');
    expect(final.engine).toBe('claude');
    expect(final.bytes).toBe(raw.length);
    expect(final.blocks.map((b) => (b.kind === 'text' ? b.text : ''))).toEqual(['hello', 'world']);
  });
});
