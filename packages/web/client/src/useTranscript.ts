import { useEffect, useState } from 'react';
import { api } from './api.js';
import type { Status, TranscriptBlock, TranscriptEngine } from './types.js';

export interface TranscriptState {
  state: 'live' | 'final' | 'none';
  blocks: TranscriptBlock[];
  bytes: number | null;
  engine: TranscriptEngine | null;
  loading: boolean;
}

const EMPTY: TranscriptState = { state: 'none', blocks: [], bytes: null, engine: null, loading: true };

/**
 * Poll a task's agent transcript. While the agent runs (status === 'in_progress') it streams from
 * the live session tail every `liveMs`; once finished it fetches the persisted artifact once. Each
 * response is the full current parse, so we just replace the block list (block.id is the React key,
 * no manual merge). getTranscript never throws server-side; a network failure leaves the last view.
 */
export function useTranscript(taskKey: string, status: Status, liveMs = 2000): TranscriptState {
  const [tx, setTx] = useState<TranscriptState>(EMPTY);
  useEffect(() => {
    let alive = true;
    setTx(EMPTY);
    const tick = () => {
      api.getTranscript(taskKey)
        .then((r) => { if (alive) setTx({ state: r.state, blocks: r.blocks, bytes: r.bytes, engine: r.engine, loading: false }); })
        .catch(() => { if (alive) setTx((p) => ({ ...p, loading: false })); });
    };
    tick();
    if (status !== 'in_progress') return () => { alive = false; };
    const id = setInterval(tick, liveMs);
    return () => { alive = false; clearInterval(id); };
  }, [taskKey, status, liveMs]);
  return tx;
}
