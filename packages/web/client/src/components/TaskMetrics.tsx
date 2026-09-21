import type { TaskMetricsView } from '../types.js';
import { fmtDur, fmtNum } from '../metrics.js';

type Usage = NonNullable<TaskMetricsView['tokenBreakdown']>[number];
const stageLabel = (stage: Usage['stage']) => stage === 'description' ? 'Description'
  : stage === 'plan' ? 'Plan' : stage === 'implementation' ? 'Implementation' : 'Unknown';
const exactTokens = (value: number | null) => value === null ? 'n/a' : value.toLocaleString('en-US');
const sumTokens = (values: Array<number | null>) => values.every(v => v === null)
  ? null : values.reduce<number>((total, v) => total + (v ?? 0), 0);

function TokenBreakdown({ rows }: { rows: Usage[] }) {
  const stages = [...new Set(rows.map(row => row.stage))];
  const totals = (group: Usage[]) => [
    sumTokens(group.map(row => row.tokensIn)),
    sumTokens(group.map(row => row.tokensOut)),
    sumTokens(group.flatMap(row => [row.tokensIn, row.tokensOut])),
  ];
  return (
    <details className="af-token-breakdown">
      <summary>Token breakdown</summary>
      <div className="af-token-table-scroll" role="region" aria-label="Token breakdown" tabIndex={0}>
        <table aria-label="Token usage by stage, agent and model">
          <thead><tr><th scope="col">Stage</th><th scope="col">Agent</th><th scope="col">Model</th><th scope="col">Input</th><th scope="col">Output</th><th scope="col">Total</th></tr></thead>
          {stages.map(stage => {
            const group = rows.filter(row => row.stage === stage);
            return <tbody key={stage ?? 'unknown'}>
              {group.map(row => <tr key={JSON.stringify([row.agent, row.model])}>
                <td>{stageLabel(stage)}</td>
                <td>{row.agent === 'codex' ? 'Codex' : row.agent === 'claude' ? 'Claude' : 'Unknown'}</td>
                <th scope="row" className="af-token-model">{row.model ?? 'Unknown'}</th>
                <td>{exactTokens(row.tokensIn)}</td><td>{exactTokens(row.tokensOut)}</td>
                <td>{exactTokens(sumTokens([row.tokensIn, row.tokensOut]))}</td>
              </tr>)}
              {group.length > 1 && <tr className="af-token-subtotal">
                <th scope="row" colSpan={3}>{stageLabel(stage)} subtotal</th>
                {totals(group).map((value, i) => <td key={i}>{exactTokens(value)}</td>)}
              </tr>}
            </tbody>;
          })}
          <tfoot><tr><th scope="row" colSpan={3}>All stages</th>
            {totals(rows).map((value, i) => <td key={i}>{exactTokens(value)}</td>)}
          </tr></tfoot>
        </table>
      </div>
      <p>Reported usage across all attempts. Stages are inferred from work-session timing. Unknown means attribution was not recorded; n/a means no count was reported. Totals sum the available counts. Review and visualization usage is included where reported, without a separate activity split.</p>
    </details>
  );
}

const SEGS: Array<{ label: string; hue: string; get: (m: TaskMetricsView) => number }> = [
  { label: 'queued', hue: 'var(--st-queued)', get: (m) => m.queueMin },
  { label: 'work', hue: 'var(--st-progress)', get: (m) => m.workMin },
  { label: 'review', hue: 'var(--st-review)', get: (m) => m.reviewMin },
  { label: 'blocked', hue: 'var(--st-blocked)', get: (m) => m.blockedMin },
  { label: 'delivering', hue: 'var(--st-delivering)', get: (m) => m.deliveringMin ?? 0 }, // ?? 0: stale server build
];

export function TaskMetrics({ metrics }: { metrics: TaskMetricsView }) {
  const hasTokens = metrics.tokensIn != null || metrics.tokensOut != null;
  if (metrics.claimCount === 0 && !hasTokens) {
    return <div className="af-mnone">No metrics yet — this task hasn't been worked.</div>;
  }
  const segs = SEGS.filter((s) => s.get(metrics) > 0);
  const total = segs.reduce((a, s) => a + s.get(metrics), 0) || 1;
  return (
    <div className="af-metrics">
      {segs.length > 0 && (<>
        <div className="af-mtimeline">
          {segs.map((s) => (
            <i key={s.label} style={{ width: (s.get(metrics) / total) * 100 + '%', background: s.hue }}></i>
          ))}
        </div>
        <div className="af-mlegend">
          {segs.map((s) => (
            <span key={s.label}><i style={{ background: s.hue }}></i>{s.label} <span className="t">{fmtDur(s.get(metrics))}</span></span>
          ))}
        </div>
      </>)}
      <div className="af-mchips">
        <span className="af-mchip">
          {metrics.rounds === 0 ? 'first-pass' : `${metrics.rounds} review round${metrics.rounds === 1 ? '' : 's'}`}
        </span>
        {hasTokens
          ? <span className="af-mchip"><b>{fmtNum(metrics.tokensIn)}</b> in / <b>{fmtNum(metrics.tokensOut)}</b> out</span>
          : <span className="af-mchip na">tokens n/a</span>}
        {metrics.costUsd != null
          ? <span className="af-mchip">${metrics.costUsd.toFixed(2)}{metrics.model && <> · <b>{metrics.model}</b></>}</span>
          : <span className="af-mchip na">cost n/a · not reported</span>}
      </div>
      {!!metrics.tokenBreakdown?.length && <TokenBreakdown rows={metrics.tokenBreakdown} />}
      {hasTokens && !metrics.tokenBreakdown?.length && <div className="af-mnone">Token breakdown unavailable for these reports.</div>}
    </div>
  );
}
