import { useEffect, useRef } from 'react';

export function useEventStream(onBump: () => void): void {
  const cb = useRef(onBump);
  cb.current = onBump;
  useEffect(() => {
    let es: EventSource | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    const startPolling = () => { if (!pollTimer) pollTimer = setInterval(() => cb.current(), 3000); };
    const stopPolling = () => { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } };
    es = new EventSource('/events');
    es.addEventListener('version', () => { stopPolling(); cb.current(); });
    es.addEventListener('open', () => stopPolling());
    es.onerror = () => { startPolling(); }; // browser auto-reconnects EventSource; poll meanwhile
    return () => { es?.close(); stopPolling(); };
  }, []);
}
