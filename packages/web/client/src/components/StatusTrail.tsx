import type { Activity, Status } from '../types.js';
import { STATUS_LABELS, STATUS_COLORS } from '../status.js';

/**
 * The ordered status path a task has travelled, reconstructed from its status_change activity
 * (sorted by id for true chronological order): [first.from, ...each.to]. Revisits stay in place
 * so rework loops show up. Empty history ⇒ just the current status.
 */
export function statusPath(activity: Activity[], current: Status): Status[] {
  const changes = activity
    .filter((a) => a.type === 'status_change' && a.fromStatus !== null && a.toStatus !== null)
    .sort((a, b) => a.id - b.id);
  if (changes.length === 0) return [current];
  return [changes[0]!.fromStatus!, ...changes.map((c) => c.toStatus!)];
}

/** Compact, at-a-glance journey of the statuses a task moved through; the current status is highlighted. */
export function StatusTrail({ activity, current }: { activity: Activity[]; current: Status }) {
  const path = statusPath(activity, current);
  return (
    <div className="af-trail">
      {path.map((s, i) => (
        <span key={i} className="af-trail-step">
          {i > 0 && <span className="af-trail-arrow">→</span>}
          <span
            className={'af-trail-chip' + (i === path.length - 1 ? ' current' : '')}
            style={{ color: STATUS_COLORS[s], background: `color-mix(in srgb, ${STATUS_COLORS[s]} 14%, transparent)` }}
          >
            {STATUS_LABELS[s]}
          </span>
        </span>
      ))}
    </div>
  );
}
