import type { Activity } from '../types.js';
import { shortTime } from '../time.js';
import { I } from '../icons.js';

/**
 * Why a task is currently blocked: the note an agent attached on the latest move to `blocked`
 * (it rides in that status_change's body). Blocks recorded before reason-capture carry no note,
 * so fall back to the most recent plain comment. Derived from the activity log — no stored column.
 * Sorted by id (monotonic) for true chronological order, regardless of the array's arrival order.
 */
export function blockReason(activity: Activity[]): { text: string | null; at: string | null } {
  const byId = [...activity].sort((a, b) => a.id - b.id);
  let at: string | null = null;
  for (let i = byId.length - 1; i >= 0; i--) {
    const a = byId[i]!;
    if (a.type === 'status_change' && a.toStatus === 'blocked') {
      at = a.createdAt;
      if (a.body.trim()) return { text: a.body.trim(), at };
      break; // found the block, but it carried no reason — try a comment instead
    }
  }
  for (let i = byId.length - 1; i >= 0; i--) {
    const a = byId[i]!;
    // skip the structured marker comments (failure/v1, ai-review/v1) — they aren't a human reason
    if (a.type === 'comment' && a.body.trim() && !/^(failure|ai-review)\/v1/i.test(a.body))
      return { text: a.body.trim(), at };
  }
  return { text: null, at };
}

/** Drawer banner that puts the block reason (and the unblock action) front-and-center for a blocked task. */
export function BlockedBanner({ activity, onUnblock }: { activity: Activity[]; onUnblock: () => void }) {
  const { text, at } = blockReason(activity);
  return (
    <div className="af-blockbanner">
      <div className="af-blockbanner-head">
        {I.info({})}
        <strong>Blocked</strong>
        {at && <span className="af-blockbanner-meta">{shortTime(at)}</span>}
      </div>
      <div className={'af-blockbanner-detail' + (text ? '' : ' muted')}>
        {text ?? "No reason given — the agent didn't say why."}
      </div>
      <button className="af-mini" onClick={onUnblock}>Unblock → Queued</button>
    </div>
  );
}
