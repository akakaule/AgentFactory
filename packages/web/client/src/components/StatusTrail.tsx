import type { Activity, Status, Stage } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS, STAGE_LABELS, STAGE_COLORS } from '../status.js';
import { shortTime } from '../time.js';

export interface TrailStep {
  status: Status;
  stage: Stage; // the pipeline stage this node belonged to
  at: string; // createdAt of the transition that entered this status ('' when synthesized)
  who: string; // attributed actor name, mirroring ActivityItem
  note: string; // the status_change body (claim label, advance note, …)
}

// A stage advance rides the in_review→queued status_change body as "… stage <from> → <to>".
// A rework rejection takes the same edge but writes no such marker — so this is the signal that
// distinguishes a real stage advance from a rework loop. Source: core/src/ops/approval.ts.
const STAGE_RE = /stage (description|plan|implementation) (?:→|->) (description|plan|implementation)/;

/**
 * The ordered nodes a task has travelled, reconstructed from its status_change activity (sorted
 * by id for true chronological order), each tagged with the pipeline stage it belonged to. One
 * node per transition, sourced from the activity that *entered* it (the creation null→backlog
 * entry supplies the first node). Revisits stay in place so rework loops show up. Empty history ⇒
 * just the current status/stage.
 */
export function trailSteps(activity: Activity[], current: Status, currentStage: Stage): TrailStep[] {
  const all = activity
    .filter((a) => a.type === 'status_change' && a.toStatus !== null)
    .sort((a, b) => a.id - b.id);
  if (all.length === 0) return [{ status: current, stage: currentStage, at: '', who: 'you', note: '' }];
  // Start at the first advance marker's `from` stage; with no markers the whole journey is the
  // current stage (e.g. a task created straight into the implementation stage).
  const first = all.map((a) => STAGE_RE.exec(a.body)).find(Boolean);
  let stage: Stage = first ? (first[1] as Stage) : currentStage;
  return all.map((a) => {
    const m = STAGE_RE.exec(a.body);
    if (m) stage = m[2] as Stage; // the advance entry enters the new stage's queued node
    return {
      status: a.toStatus!,
      stage,
      at: a.createdAt,
      note: a.body,
      who: a.actorName ?? (a.actor === 'agent' ? 'agent' : 'you'),
    };
  });
}

function tooltip(s: TrailStep): string {
  return [s.who, s.at && shortTime(s.at), s.note].filter(Boolean).join(' · ');
}

/**
 * The journey a task moved through, grouped into one labeled row per pipeline stage so the
 * repeating queued→in_progress→in_review cycles stay legible. The current status is highlighted;
 * each pill reveals who/when/note on hover.
 */
export function StatusTrail({ activity, current, currentStage }: { activity: Activity[]; current: Status; currentStage: Stage }) {
  const steps = trailSteps(activity, current, currentStage);
  // collapse consecutive same-stage steps into rows, preserving order
  const rows: { stage: Stage; steps: TrailStep[] }[] = [];
  for (const s of steps) {
    const last = rows[rows.length - 1];
    if (last && last.stage === s.stage) last.steps.push(s);
    else rows.push({ stage: s.stage, steps: [s] });
  }
  const lastRow = rows.length - 1;
  return (
    <div className="af-trail">
      {rows.map((row, ri) => (
        <div key={ri} className="af-trail-row">
          <span
            className="af-trail-stage"
            style={{ color: STAGE_COLORS[row.stage], background: `color-mix(in srgb, ${STAGE_COLORS[row.stage]} 16%, transparent)` }}
          >
            {STAGE_LABELS[row.stage]}
          </span>
          <div className="af-trail-pills">
            {row.steps.map((s, i) => {
              const isCurrent = ri === lastRow && i === row.steps.length - 1;
              return (
                <span key={i} className="af-trail-step">
                  {!(ri === 0 && i === 0) && <span className="af-trail-arrow">→</span>}
                  <span
                    className={'af-trail-chip' + (isCurrent ? ' current' : '')}
                    style={{ color: STATUS_COLORS[s.status], background: `color-mix(in srgb, ${STATUS_COLORS[s.status]} 14%, transparent)` }}
                    title={tooltip(s)}
                  >
                    {STATUS_LABELS[s.status]}
                  </span>
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
