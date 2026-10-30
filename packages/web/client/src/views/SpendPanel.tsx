import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api.js';
import { useEventStream } from '../useEventStream.js';
import type { Workspace } from '../types.js';
import {
  computeSpend, fmtNum, fmtUsd, monthLabel, recentMonths,
  type SpendMetric, type SpendMonth, type SpendSplit,
} from '../metrics.js';

const MONTH_TABS = 3;

/** Legend/tooltip amounts: whole dollars from $100 up, cents below. */
function fmtAmount(v: number, metric: SpendMetric): string {
  if (metric === 'tokens') return fmtNum(v);
  return v >= 100 ? '$' + Math.round(v).toLocaleString('en-US') : fmtUsd(v);
}
function fmtTick(v: number, metric: SpendMetric, max: number): string {
  if (metric === 'tokens') return fmtNum(v);
  return max >= 10 ? '$' + v.toLocaleString('en-US') : '$' + v.toFixed(2);
}
function joinNames(names: string[]): string {
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}
const dayLabel = (iso: string) =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });

/**
 * Monthly AI spend: a headline total split by provider or workspace, then daily stacked bars.
 * The month + workspace pick the data (one fetch each); metric and split are client-side views.
 */
export function SpendPanel({ workspaces }: { workspaces: Workspace[] }) {
  const months = useMemo(() => recentMonths(Date.now(), MONTH_TABS), []);
  const [month, setMonth] = useState(months[0]!);
  const [ws, setWs] = useState(''); // '' = all workspaces (a workspace may literally be named "all")
  const [metric, setMetric] = useState<SpendMetric>('cost');
  const [split, setSplit] = useState<SpendSplit>('provider');
  const [data, setData] = useState<{ key: string; spend: SpendMonth; fetchedAt: Date } | null>(null);
  const [err, setErr] = useState<{ key: string; message: string } | null>(null);

  // A selection change bumps the generation: answers for an older selection are dropped, and a
  // refetch asked for while one is in flight runs once, after it settles (coalesced SSE bumps).
  const sel = useRef({ ws: '', month: months[0]! });
  const selGen = useRef(0);
  const inflight = useRef<{ gen: number; again: boolean } | null>(null);
  const keyOf = (s: { ws: string; month: string }) => `${s.ws}\u0000${s.month}`;
  const key = keyOf({ ws, month });

  const refetch = useCallback(function fetchSpend(): void {
    const gen = selGen.current;
    const active = inflight.current;
    if (active?.gen === gen) {
      active.again = true;
      return;
    }
    const selected = { ...sel.current };
    inflight.current = { gen, again: false };
    const settle = (result: { spend: SpendMonth } | { message: string }) => {
      if (gen !== selGen.current) return;
      const again = inflight.current?.gen === gen && inflight.current.again;
      inflight.current = null;
      if ('spend' in result) {
        setData({ key: keyOf(selected), spend: result.spend, fetchedAt: new Date() });
        setErr(null);
      } else {
        setErr({ key: keyOf(selected), message: result.message });
      }
      if (again) fetchSpend();
    };
    api.getSpend(selected.month, selected.ws || undefined)
      .then((spend) => settle({ spend }))
      .catch((e: unknown) => settle({ message: e instanceof Error && e.message ? e.message : 'Could not load spend.' }));
  }, []);
  useEffect(refetch, [refetch]);
  useEventStream(refetch);

  const select = (next: { ws: string; month: string }) => {
    if (keyOf(next) === keyOf(sel.current)) return;
    sel.current = next;
    setWs(next.ws);
    setMonth(next.month);
    selGen.current += 1;
    inflight.current = null;
    setErr(null);
    refetch();
  };

  const workspaceOrder = useMemo(() => workspaces.map((w) => w.name), [workspaces]);
  const current = data?.key === key ? data : null;
  const view = useMemo(
    () => (current ? computeSpend(current.spend, split, metric, workspaceOrder) : null),
    [current, split, metric, workspaceOrder],
  );
  const scope = `${ws || 'all workspaces'}, ${monthLabel(month)}`;

  return (
    <section className="an-panel span an-spend" aria-label="Spend">
      <div className="an-spend-bar">
        <div className="af-range" role="group" aria-label="Month">
          {months.map((m) => (
            <button key={m} className={m === month ? 'on' : ''} onClick={() => select({ ws, month: m })}>{monthLabel(m)}</button>
          ))}
        </div>
        <select className="an-spend-ws" aria-label="Spend workspace" value={ws} onChange={(e) => select({ ws: e.target.value, month })}>
          <option value="">All workspaces</option>
          {workspaces.map((w) => <option key={w.id} value={w.name}>{w.name}</option>)}
        </select>
        <div className="an-tg" role="group" aria-label="Measure">
          <button className={metric === 'cost' ? 'on' : ''} onClick={() => setMetric('cost')}>Cost</button>
          <button className={metric === 'tokens' ? 'on' : ''} onClick={() => setMetric('tokens')}>Tokens</button>
        </div>
        <div className="an-tg" role="group" aria-label="Split">
          <button className={split === 'provider' ? 'on' : ''} onClick={() => setSplit('provider')}>By provider</button>
          <button className={split === 'workspace' ? 'on' : ''} onClick={() => setSplit('workspace')}>By workspace</button>
        </div>
        {current && (
          <span className="an-spend-meta">{current.spend.dataUpTo ? `Data up to ${dayLabel(current.spend.dataUpTo)}` : 'No usage reported'}</span>
        )}
        <span className="grow"></span>
        {current && <span className="an-spend-meta">Last fetched {current.fetchedAt.toLocaleTimeString('en-GB')}</span>}
        <button className="an-more" onClick={refetch}>Refresh</button>
      </div>

      {err?.key === key ? (
        <div className="an-spend-error">
          <b>Couldn't load spend for {scope}</b>
          <span>{err.message}</span>
          <button className="af-btn-primary" onClick={() => { setErr(null); refetch(); }}>Retry</button>
        </div>
      ) : !view ? (
        <div className="an-spend-loading">Loading spend for {scope}…</div>
      ) : (
        <>
          <div className="an-spend-head">
            <div className="an-spend-title">{metric === 'cost' ? 'Total spend' : 'Total tokens'}, {scope}</div>
            <div className="an-spend-hero">
              <span className="an-spend-total">{metric === 'cost' ? fmtUsd(view.total) : fmtNum(view.total)}</span>
              <span className="an-spend-src">{view.series.length ? joinNames(view.series.map((s) => s.key)) : metric === 'cost' ? 'nothing priced' : 'nothing reported'}</span>
            </div>
            {view.series.length > 0 && (
              <div className="an-spend-split">
                {view.series.map((s) => (
                  <i key={s.key} style={{ flexGrow: s.value, background: s.color }} title={`${s.key} ${fmtAmount(s.value, metric)}`}></i>
                ))}
              </div>
            )}
            <div className="an-spend-legend">
              {view.series.map((s) => (
                <span key={s.key}><i style={{ background: s.color }}></i>{s.key}<b>{fmtAmount(s.value, metric)}</b></span>
              ))}
            </div>
            {metric === 'cost' && view.unpricedTokens > 0 && (
              <div className="an-caption">{fmtNum(view.unpricedTokens)} tokens have no price, so they are not in this total. Set prices in Agents › Prices.</div>
            )}
          </div>

          <div className="an-spend-chart" role="img" aria-label={`Daily ${metric === 'cost' ? 'spend' : 'tokens'} for ${scope}`}>
            <div className="an-spend-axis">
              {view.ticks.map((t) => (
                <span key={t} style={{ bottom: `${(t / view.max) * 100}%` }}>{fmtTick(t, metric, view.max)}</span>
              ))}
            </div>
            <div className="an-spend-plot">
              {view.ticks.map((t) => <i key={t} className="grid" style={{ bottom: `${(t / view.max) * 100}%` }}></i>)}
              {view.days.map((d) => {
                const parts = view.series.filter((s) => (d.values[s.key] ?? 0) > 0);
                const title = parts.length
                  ? `${d.date} · ${parts.map((s) => `${s.key} ${fmtAmount(d.values[s.key]!, metric)}`).join(' · ')}`
                  : `${d.date} · nothing reported`;
                return (
                  <div className="an-spend-day" key={d.date} title={title}>
                    <div className="stack" style={{ height: `${(d.total / view.max) * 100}%` }}>
                      {parts.map((s) => <i key={s.key} style={{ flexGrow: d.values[s.key], background: s.color }}></i>)}
                    </div>
                    <span className="date">{Number(d.date.slice(8)) % 2 === 0 ? d.date.slice(8) : ''}</span>
                  </div>
                );
              })}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
