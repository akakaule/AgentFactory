import { useEffect, useMemo, useState } from 'react';
import { useTelemetry } from '../useTelemetry.js';
import { fmtTokens } from '../liveFormat.js';
import { shortTime } from '../time.js';
import { I } from '../icons.js';
import type { TelemetryEvent } from '../types.js';

const AGENT_META: Record<TelemetryEvent['agent'], { label: string; cls: string }> = {
  'claude-code': { label: 'Claude', cls: 'claude' },
  codex: { label: 'Codex', cls: 'codex' },
};

function fmtCost(n: number | null): string {
  if (n == null) return '–';
  return '$' + (n < 1 ? n.toFixed(4) : n.toFixed(2));
}

/** Live feed of OTel token events as Claude/Codex submit them to POST /v1/logs. */
export function TelemetryView({ onOpen }: { onOpen: (key: string) => void }) {
  const events = useTelemetry();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const nowDate = new Date(now);

  // Rolling totals over the events currently in the window (newest ~200, not all-time).
  const sum = useMemo(() => {
    let tin = 0, tout = 0, cost = 0, hasCost = false;
    const byAgent: Record<TelemetryEvent['agent'], number> = { 'claude-code': 0, codex: 0 };
    const byModel = new Map<string, number>();
    for (const e of events) {
      tin += e.tokensIn; tout += e.tokensOut;
      if (e.costUsd != null) { cost += e.costUsd; hasCost = true; }
      byAgent[e.agent]++;
      const m = e.model ?? 'unknown';
      byModel.set(m, (byModel.get(m) ?? 0) + 1);
    }
    const models = [...byModel.entries()].sort((a, b) => b[1] - a[1]);
    return { tin, tout, cost, hasCost, byAgent, models };
  }, [events]);

  if (events.length === 0) {
    return (
      <div className="af-live-empty">
        <div className="ico">{I.clock({})}</div>
        <h2>No telemetry yet</h2>
        <p>
          As Claude or Codex export token usage to the OTLP endpoint (<span className="mono">POST /v1/logs</span>),
          each event lands here live — worker, agent, model, tokens, and cost. Wire a session per the token-telemetry docs.
        </p>
      </div>
    );
  }

  return (
    <div className="an-scroll">
      <div className="an-wrap">
        <div className="an-toolbar">
          <h1>Telemetry</h1>
          <span className="sub">· live OTel feed · {events.length} recent events</span>
        </div>

        <div className="af-tel-sum">
          <div className="af-tel-stat"><div className="v mono">{fmtTokens(sum.tin)}</div><div className="l">Tokens in</div></div>
          <div className="af-tel-stat"><div className="v mono">{fmtTokens(sum.tout)}</div><div className="l">Tokens out</div></div>
          <div className="af-tel-stat"><div className="v mono">{sum.hasCost ? fmtCost(sum.cost) : '–'}</div><div className="l">Cost</div></div>
          <div className="af-tel-chips">
            {(['claude-code', 'codex'] as const).filter((a) => sum.byAgent[a] > 0).map((a) => (
              <span key={a} className={'af-tel-agent ' + AGENT_META[a].cls}><span className="d"></span>{AGENT_META[a].label} · {sum.byAgent[a]}</span>
            ))}
            {sum.models.slice(0, 4).map(([m, n]) => (
              <span key={m} className="af-tel-model mono" title={m}>{m} · {n}</span>
            ))}
          </div>
        </div>

        <div className="an-panel span">
          <table className="an-table af-tel-table">
            <thead>
              <tr>
                <th>Time</th><th>Task</th><th>Workspace</th><th>Worker</th><th>Agent</th><th>Model</th>
                <th className="r">In</th><th className="r">Out</th><th className="r">Cost</th>
              </tr>
            </thead>
            <tbody>
              {events.map((e) => {
                const ag = AGENT_META[e.agent];
                return (
                  <tr key={e.seq}>
                    <td className="dim" title={e.at}>{shortTime(e.at, nowDate)}</td>
                    <td>{e.taskKey
                      ? <button className="af-tel-key mono" onClick={() => onOpen(e.taskKey!)}>{e.taskKey}</button>
                      : <span className="dim" title="arrived without a task key">unattributed</span>}</td>
                    <td>{e.workspace ? <span className="af-wsbadge">{e.workspace}</span> : <span className="dim">–</span>}</td>
                    <td className="mono dim">{e.worker ?? '–'}</td>
                    <td><span className={'af-tel-agent ' + ag.cls}><span className="d"></span>{ag.label}</span></td>
                    <td className="mono dim">{e.model ?? '–'}</td>
                    <td className="r mono">{fmtTokens(e.tokensIn)}</td>
                    <td className="r mono">{fmtTokens(e.tokensOut)}</td>
                    <td className="r mono">{fmtCost(e.costUsd)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
