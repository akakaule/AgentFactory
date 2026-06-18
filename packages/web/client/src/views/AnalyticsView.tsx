import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { useEventStream } from '../useEventStream.js';
import { useWorkspaces } from '../useWorkspaces.js';
import { wsColor } from '../wsColor.js';
import { computeAnalytics, fmtDur, fmtNum, type AnalyticsData } from '../metrics.js';
import { I } from '../icons.js';

interface Props {
  ws: string;
  rangeDays: number | null;
  onRange: (d: number | null) => void;
}

function StageRow({ label, hue, mono, val, max, fmt }: {
  label: string; hue: string; mono?: boolean; val: number; max: number; fmt?: (v: number) => string;
}) {
  return (
    <div className="an-stage">
      <span className={'n' + (mono ? ' mono' : '')}>{!mono && <span className="sw" style={{ background: hue }}></span>}{label}</span>
      <span className="an-bar"><i style={{ width: Math.max(2, (val / max) * 100) + '%', background: hue }}></i></span>
      <span className="t">{fmt ? fmt(val) : val}</span>
    </div>
  );
}

function AnalyticsEmpty({ ws, rangeDays }: { ws: string; rangeDays: number | null }) {
  return (
    <div className="an-empty">
      <div className="ico">{I.chart({})}</div>
      <h2>No completed tasks in this range</h2>
      <p>Metrics are derived from the activity log. As soon as a task is reviewed and marked done, its timing, quality, and cost land here.</p>
      <div className="hint">workspace: {ws === 'all' ? 'all' : ws} · range: {rangeDays ? rangeDays + 'd' : 'all time'}</div>
    </div>
  );
}

type TokGroup = 'model' | 'workspace';

export function AnalyticsView({ ws, rangeDays, onRange }: Props) {
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [tokGroup, setTokGroup] = useState<TokGroup>('model');
  const refetch = useCallback(() => { api.getAnalytics().then(setData).catch(() => {}); }, []);
  useEffect(refetch, [refetch]);
  useEventStream(refetch);
  const { workspaces } = useWorkspaces();

  const a = useMemo(() => (data ? computeAnalytics(data, ws, rangeDays) : null), [data, ws, rangeDays]);
  const rangeLabel = rangeDays ? `last ${rangeDays} days` : 'all time';

  return (
    <div className="an-scroll">
      <div className="an-wrap">
        <div className="an-toolbar">
          <h1>Analytics</h1>
          <span className="sub">· {ws === 'all' ? 'all workspaces' : ws} · {rangeLabel}</span>
          <span className="grow"></span>
          <div className="af-range">
            <button className={rangeDays === 7 ? 'on' : ''} onClick={() => onRange(7)}>7d</button>
            <button className={rangeDays === 30 ? 'on' : ''} onClick={() => onRange(30)}>30d</button>
            <button className={rangeDays === null ? 'on' : ''} onClick={() => onRange(null)}>All</button>
          </div>
        </div>

        {!a && <div style={{ color: 'var(--ink-3)', fontSize: 13 }}>Loading…</div>}
        {a && !a.hasData && <AnalyticsEmpty ws={ws} rangeDays={rangeDays} />}
        {a && a.hasData && (() => {
          const k = a.kpis;
          const tokRows = tokGroup === 'model'
            ? a.tokensByModel.map((t) => ({ key: t.model, val: t.tokens }))
            : a.tokensByWorkspace.map((t) => ({ key: t.workspace, val: t.tokens }));
          const tokMax = tokGroup === 'model' ? a.tokMax : a.tokWsMax;
          return (<>
          {/* KPIs */}
          <div className="an-kpis">
            <div className="an-kpi">
              <div className="v">{k.done}</div><div className="l">Tasks done</div>
              <div className="d">{k.delta == null ? <span className="flat">all time</span> :
                k.delta > 0 ? <><span className="up">▲ {k.delta}</span> vs prev {rangeDays}d</> :
                k.delta < 0 ? <><span className="down">▼ {Math.abs(k.delta)}</span> vs prev {rangeDays}d</> :
                <><span className="flat">no change</span> vs prev</>}</div>
            </div>
            <div className="an-kpi">
              <div className="v">{fmtDur(k.cycle)}</div><div className="l">Median cycle time</div>
              <div className="d">queued → done</div>
            </div>
            <div className="an-kpi">
              <div className="v">{fmtDur(k.work)}</div><div className="l">Median work time</div>
              <div className="d">claim → submit</div>
            </div>
            <div className="an-kpi">
              <div className="v">{k.firstPass.rate}%</div><div className="l">First-pass approval</div>
              <div className="d">{k.firstPass.n} / {k.firstPass.d} no feedback</div>
            </div>
            <div className="an-kpi">
              <div className="v">{k.reopen.rate}%</div><div className="l">Reopen rate</div>
              <div className="d">{k.reopen.n} / {k.reopen.d} post-done</div>
            </div>
            <div className="an-kpi">
              {k.override.d === 0
                ? <div className="v na">n/a</div>
                : <div className="v">{k.override.rate}%</div>}
              <div className="l">AI override rate</div>
              <div className="d">{k.override.d === 0
                ? <span className="flat">no AI reviews</span>
                : <>{k.override.n} / {k.override.d} approved past findings</>}</div>
            </div>
            <div className="an-kpi">
              {k.cost.per == null
                ? <div className="v na">n/a</div>
                : <div className="v">${k.cost.per.toFixed(2)}</div>}
              <div className="l">Cost / accepted task</div>
              <div className="d">{k.cost.reported} of {k.cost.total} reported</div>
            </div>
          </div>

          {/* Where time goes + Throughput */}
          <div className="an-grid2">
            <div className="an-panel">
              <div className="an-ph"><h3>Where time goes</h3><small>· median per stage</small></div>
              <div className="an-seg">
                {a.stages.filter((s) => s.val > 0).map((s) => (
                  <i key={s.key} style={{ width: (s.val / a.stageTotal) * 100 + '%', background: s.hue }}>
                    {(s.val / a.stageTotal) > 0.12 && <span>{fmtDur(s.val)}</span>}
                  </i>
                ))}
              </div>
              {a.stages.map((s) => <StageRow key={s.key} label={s.label} hue={s.hue} val={s.val} max={a.dominant.val || 1} fmt={fmtDur} />)}
              <div className="an-caption">
                <b>{a.dominant.label}</b> dominates the cycle — in practice the human review queue is the bottleneck, not the agents.
              </div>
            </div>

            <div className="an-panel">
              <div className="an-ph"><h3>Throughput</h3><small>· tasks done per day</small><span className="right">{a.throughput.reduce((s, d) => s + d.count, 0)} total</span></div>
              <div className="an-tp">
                {a.throughput.map((d, i) => (
                  <div className="col" key={i}>
                    <div className="stack">
                      <div className={'b' + (d.count === a.tpMax && d.count > 0 ? ' hot' : '')} style={{ height: (d.count / a.tpMax) * 100 + '%' }}>
                        {d.count > 0 && <span className="cnt">{d.count}</span>}
                      </div>
                    </div>
                    <span className="d">{d.label}</span>
                  </div>
                ))}
              </div>
              <div className="an-caption">Recent throughput across the {a.tpDays}-day window. Tall bars cluster around review sessions.</div>
            </div>
          </div>

          {/* Review round-trips + Tokens by model */}
          <div className="an-grid2">
            <div className="an-panel">
              <div className="an-ph"><h3>Review round-trips</h3><small>· feedback loops before approval</small></div>
              <StageRow label="First pass" hue="var(--green)" val={a.rounds.first} max={Math.max(1, a.rounds.first, a.rounds.one, a.rounds.two)} />
              <StageRow label="1 round" hue="var(--active)" val={a.rounds.one} max={Math.max(1, a.rounds.first, a.rounds.one, a.rounds.two)} />
              <StageRow label="2+ rounds" hue="var(--st-blocked)" val={a.rounds.two} max={Math.max(1, a.rounds.first, a.rounds.one, a.rounds.two)} />
              <div className="an-caption">A shrinking right tail means specs and acceptance criteria are getting sharper.</div>
            </div>

            <div className="an-panel">
              <div className="an-ph">
                <h3>Tokens by {tokGroup}</h3><small>· worker-reported</small>
                <div className="an-tg">
                  <button className={tokGroup === 'model' ? 'on' : ''} onClick={() => setTokGroup('model')}>Model</button>
                  <button className={tokGroup === 'workspace' ? 'on' : ''} onClick={() => setTokGroup('workspace')}>Workspace</button>
                </div>
              </div>
              {tokRows.length === 0
                ? <div className="an-caption" style={{ marginTop: 2 }}>No worker reported token usage in this range.</div>
                : tokRows.map((t) => <StageRow key={t.key} label={t.key} hue="var(--accent)" mono val={t.val} max={tokMax} fmt={fmtNum} />)}
              <div className="an-cov">
                {I.info({})}
                <div className="tx">
                  <b>{a.tokenCoverage.reported} of {a.tokenCoverage.total}</b> done tasks reported usage. Interactive workers often don't self-report — unreported tasks show <b>n/a</b>, never zero, so cost is never understated.
                </div>
              </div>
            </div>
          </div>

          {/* Why tasks fail — supervisor failure occurrences by reason */}
          {a.failures.total > 0 && (
            <div className="an-panel span">
              <div className="an-ph"><h3>Why tasks fail</h3><small>· supervisor failures, {rangeLabel}</small><span className="right">{a.failures.total} total</span></div>
              {a.failures.byReason.map((f) => (
                <StageRow key={f.reason} label={f.label} hue="var(--st-blocked)" val={f.count} max={a.failures.max} />
              ))}
              <div className="an-caption">Every timeout, crash, permission denial, and skip-list the dispatcher and reviewer recorded. A spike by reason points at the fix — raise the stage timeout, widen the tool allowlist, or harden the verify command.</div>
            </div>
          )}

          {/* Workers */}
          <div className="an-panel span">
            <div className="an-ph"><h3>Workers</h3><small>· {rangeLabel}</small></div>
            <table className="an-table">
              <thead>
                <tr>
                  <th>Worker</th><th>Workspace</th><th className="r">Claims</th><th className="r">Done</th>
                  <th>First-pass</th><th className="r">Med. work</th><th className="r">Releases</th><th className="r">Tokens</th><th className="r">Cost</th>
                </tr>
              </thead>
              <tbody>
                {a.workers.map((w) => {
                  const unl = w.name === '(unlabeled)';
                  return (
                    <tr key={w.name}>
                      <td><span className="an-wk"><span className="dot" style={{ background: unl ? 'var(--ink-3)' : wsColor(workspaces, w.ws) }}></span><span className="mono" style={unl ? { color: 'var(--ink-3)' } : undefined}>{w.name}</span></span></td>
                      <td className="mono dim">{w.ws}</td>
                      <td className="r mono">{w.claims}</td>
                      <td className="r mono">{w.done}</td>
                      <td>{w.firstPass == null ? <span className="dim">—</span> :
                        <span className={'an-pill ' + (w.firstPass >= 75 ? 'good' : w.firstPass >= 50 ? 'warn' : 'bad')}><span className="dot" style={{ background: 'currentColor' }}></span>{w.firstPass}%</span>}</td>
                      <td className="r mono">{fmtDur(w.medWork)}</td>
                      <td className="r mono" style={w.releases > 0 ? { color: 'var(--active-2)' } : undefined}>{w.releases}</td>
                      <td className="r mono">{w.tokens == null ? <span className="dim">n/a</span> : fmtNum(w.tokens)}</td>
                      <td className="r mono">{w.cost == null ? <span className="dim">n/a</span> : '$' + w.cost.toFixed(2)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>); })()}
      </div>
    </div>
  );
}
