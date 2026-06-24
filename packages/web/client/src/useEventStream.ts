import { useEffect, useRef } from 'react';
import { eventsUrl } from './api.js';

export function useEventStream(onBump: () => void): void {
  const cb = useRef(onBump);
  cb.current = onBump;
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => { if (!pollTimer) pollTimer = setInterval(() => cb.current(), 3000); };
    const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    const open = () => {
      if (es) return;
      es = new EventSource(eventsUrl());
      es.addEventListener('version', () => { stopPolling(); cb.current(); });
      es.addEventListener('open', () => stopPolling());
      es.onerror = () => { startPolling(); }; // browser auto-reconnects EventSource; poll meanwhile
    };
    const close = () => { es?.close(); es = null; stopPolling(); };
    // Only hold the long-lived SSE connection while the tab is in the foreground. A hidden
    // tab that keeps its slot is how the browser's 6-per-host HTTP/1.1 pool starves once a
    // few board tabs are open — which then queues every other fetch and hangs the UI. On
    // return we reopen and refetch once to catch up on anything missed while backgrounded.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') close();
      else { open(); cb.current(); }
    };
    if (document.visibilityState !== 'hidden') open();
    document.addEventListener('visibilitychange', onVisibility);
    return () => { document.removeEventListener('visibilitychange', onVisibility); close(); };
  }, []);
}
