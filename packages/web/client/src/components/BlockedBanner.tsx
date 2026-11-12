import type { Activity, BlockSummary } from '../types.js';
import { AnswerForm } from './AnswerForm.js';
import { shortTime } from '../time.js';
import { I } from '../icons.js';
import { NextAction } from './NextAction.js';

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
      // a decision/v1 marker line is data for the answer form, not part of the reason
      const reason = a.body.replace(/(?:^|\n)decision\/v1 \{.*\}\s*$/s, '').trim();
      if (reason) return { text: reason, at };
      break; // found the block, but it carried no reason — try a comment instead
    }
  }
  for (let i = byId.length - 1; i >= 0; i--) {
    const a = byId[i]!;
    // skip the structured marker comments (failure/v1, ai-review/v1) — they aren't a human reason
    if (a.type === 'comment' && a.body.trim() && !/^(failure|ai-review)\/v[12]/i.test(a.body))
      return { text: a.body.trim(), at };
  }
  return { text: null, at };
}

/** Drawer banner that puts the block reason (and the unblock action) front-and-center for a blocked task. */
export function BlockedBanner({ activity, onUnblock, next = null, taskKey, block, onAnswered }: {
  activity: Activity[]; onUnblock: () => void; next?: string | null;
  /** With the task's derived block, the banner shows the agent's question and an answer form. */
  taskKey?: string; block?: BlockSummary | null | undefined; onAnswered?: () => void;
}) {
  const derived = blockReason(activity);
  const text = block?.reason ?? derived.text;
  const at = block?.at ?? derived.at;
  const decision = block?.decision ?? null;
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
      {decision && <div className="af-blockbanner-detail"><strong>{decision.question}</strong></div>}
      <NextAction sentence={next} />
      {taskKey && onAnswered && <AnswerForm taskKey={taskKey} block={block} onDone={onAnswered} />}
      <button className="af-mini" onClick={onUnblock}>Unblock → Queued</button>
    </div>
  );
}
