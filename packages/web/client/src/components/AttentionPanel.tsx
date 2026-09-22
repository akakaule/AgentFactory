import { useEffect, useRef, useState } from 'react';
import { api, type AttentionState } from '../api.js';

/** Alert acknowledgement never changes task lifecycle or retry budgets. */
export function AttentionPanel({ taskKey }: { taskKey?: string }) {
  const [data, setData] = useState<AttentionState>({ occurrences: [], outbox: [] });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const request = useRef(0);
  const mutating = useRef(false);
  useEffect(() => {
    const current = ++generation.current;
    let loading = false;
    setData({ occurrences: [], outbox: [] }); setError(null); setBusy(false);
    const refresh = async () => {
      if (loading || mutating.current) return;
      loading = true;
      const sequence = ++request.current;
      try {
        const next = await api.getAttention();
        if (generation.current === current && request.current === sequence) setData(next);
      } catch (e) {
        if (generation.current === current && request.current === sequence) setError((e as Error).message);
      } finally { loading = false; }
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 15000);
    return () => { generation.current++; clearInterval(timer); };
  }, [taskKey]);

  const act = async (id: number, snooze: boolean) => {
    const current = generation.current;
    request.current++; mutating.current = true;
    setBusy(true); setError(null);
    const until = new Date(Date.now() + 3600000).toISOString();
    try {
      if (snooze) {
        const result = await api.snoozeAttention(id, until);
        if (!result.snoozed) throw new Error('Alert no longer exists.');
      } else {
        const result = await api.resolveAttention(id);
        if (!result.resolved) throw new Error('Alert no longer exists.');
      }
      if (generation.current === current) setData(previous => ({ ...previous,
        occurrences: previous.occurrences.map(a => a.id !== id ? a : { ...a,
          ...(snooze ? { snoozedUntil: until } : { resolvedAt: new Date().toISOString() }),
        }),
      }));
    } catch (e) {
      if (generation.current === current) setError((e as Error).message);
    } finally { mutating.current = false; if (generation.current === current) setBusy(false); }
  };
  const occurrences = data.occurrences.filter(a => !a.resolvedAt && (taskKey ? a.taskKey === taskKey : a.taskKey === null));
  if (!occurrences.length && !error) return null;
  return <section className="af-attention" aria-label="Attention alerts">
    {error && <div role="alert">Could not update alerts: {error}</div>}
    {occurrences.map(a => <div key={a.id} className="af-attention-item">
      <div>{a.text}</div>
      {data.outbox.filter(o => o.occurrenceId === a.id).map(o => <div key={o.id} className="af-attention-delivery">
        Notification: {o.state.replaceAll('_', ' ')} · {o.attempts}/{o.maxAttempts} attempts{o.lastError && ` · ${o.lastError}`}
      </div>)}
      {a.snoozedUntil && Date.parse(a.snoozedUntil) > Date.now() && <div>Snoozed until {new Date(a.snoozedUntil).toLocaleString()}</div>}
      <div className="af-attention-actions">
        <button className="af-mini" disabled={busy} onClick={() => void act(a.id, false)}>Acknowledge alert</button>
        <button className="af-mini" disabled={busy} onClick={() => void act(a.id, true)}>Snooze 1 hour</button>
      </div>
    </div>)}
  </section>;
}
