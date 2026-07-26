import { useEffect, useRef } from 'react';
import { eventsUrl } from './api.js';

/**
 * ONE EventSource for the whole app, shared by every useEventStream() call site.
 * Each hook instance used to open its own /events socket — with the board, drawer,
 * archive and analytics views all subscribed, a single tab held 4-6 of the browser's
 * 6-per-host HTTP/1.1 slots and starved every other fetch (the 20s timeout in api.ts
 * treats that symptom; sharing the stream removes the cause).
 *
 * The connection opens with the first subscriber and closes with the last. While the
 * tab is hidden it is released entirely (freeing the pool slot) and reopened + bumped
 * on return. On stream errors the browser auto-reconnects; we poll all subscribers
 * every 3s until the stream recovers.
 */
type Sub = { current: () => void };
const subs = new Set<Sub>();
let es: EventSource | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const bumpAll = () => { for (const s of subs) s.current(); };
const startPolling = () => { if (!pollTimer) pollTimer = setInterval(bumpAll, 3000); };
const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
const open = () => {
  if (es) return;
  es = new EventSource(eventsUrl());
  es.addEventListener('version', () => { stopPolling(); bumpAll(); });
  es.addEventListener('open', () => stopPolling());
  es.onerror = () => { startPolling(); }; // browser auto-reconnects EventSource; poll meanwhile
};
const close = () => { es?.close(); es = null; stopPolling(); };
const onVisibility = () => {
  if (document.visibilityState === 'hidden') close();
  else { open(); bumpAll(); }
};

function subscribe(sub: Sub): () => void {
  subs.add(sub);
  if (subs.size === 1) {
    if (document.visibilityState !== 'hidden') open();
    document.addEventListener('visibilitychange', onVisibility);
  }
  return () => {
    subs.delete(sub);
    if (subs.size === 0) {
      document.removeEventListener('visibilitychange', onVisibility);
      close();
    }
  };
}

export function useEventStream(onBump: () => void): void {
  const cb = useRef(onBump);
  cb.current = onBump;
  useEffect(() => subscribe(cb), []);
}
