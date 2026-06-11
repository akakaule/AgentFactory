import type { TaskMetricsView } from '../types.js';
import { fmtDur, fmtNum } from '../metrics.js';

const SEGS: Array<{ label: string; hue: string; get: (m: TaskMetricsView) => number }> = [
  { label: 'queued', hue: 'var(--st-queued)', get: (m) => m.queueMin },
  { label: 'work', hue: 'var(--st-progress)', get: (m) => m.workMin },
  { label: 'review', hue: 'var(--st-review)', get: (m) => m.reviewMin },
  { label: 'blocked', hue: 'var(--st-blocked)', get: (m) => m.blockedMin },
];

export function TaskMetrics({ metrics }: { metrics: TaskMetricsView }) {
  if (metrics.claimCount === 0) {
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
        {metrics.tokensIn != null
          ? <span className="af-mchip"><b>{fmtNum(metrics.tokensIn)}</b> in / <b>{fmtNum(metrics.tokensOut)}</b> out</span>
          : <span className="af-mchip na">tokens n/a</span>}
        {metrics.costUsd != null
          ? <span className="af-mchip">${metrics.costUsd.toFixed(2)}{metrics.model && <> · <b>{metrics.model}</b></>}</span>
          : <span className="af-mchip na">cost n/a · not reported</span>}
      </div>
    </div>
  );
}
