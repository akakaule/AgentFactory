import type { Activity } from './types.js';

/** Client-side readers for the delivering-feedback markers (the client can't import core's runtime;
 *  it already parses markers this way — see composeFeedback/composePrReview). */

export type FeedbackDisposition = 'warranted' | 'partial' | 'not_warranted';
export interface FeedbackEvalVerdict { disposition: FeedbackDisposition; reasoning: string; suggestedChange: string | null }

const DISPOSITIONS = ['warranted', 'partial', 'not_warranted'];
const isPrFeedback = (b: string) => /^pr-feedback\/v1\b/i.test(b.trimStart());
const isFeedbackEval = (b: string) => /^feedback-eval\/v1\b/i.test(b.trimStart());

function extractJson(text: string): unknown {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  let c: string | null = null;
  if (fence && fence[1] !== undefined) c = fence[1];
  else { const s = text.indexOf('{'); const e = text.lastIndexOf('}'); if (s !== -1 && e > s) c = text.slice(s, e + 1); }
  if (c === null) return null;
  try { return JSON.parse(c); } catch { return null; }
}

/** The latest feedback-eval/v1 verdict on a task, or null. */
export function latestFeedbackEval(activity: Activity[]): FeedbackEvalVerdict | null {
  const comments = activity.filter((a) => a.type === 'comment');
  for (let i = comments.length - 1; i >= 0; i--) {
    if (!isFeedbackEval(comments[i]!.body)) continue;
    const j = extractJson(comments[i]!.body);
    if (!j || typeof j !== 'object') return null;
    const o = j as Record<string, unknown>;
    const d = typeof o.disposition === 'string' ? o.disposition : '';
    if (!DISPOSITIONS.includes(d)) return null;
    return {
      disposition: d as FeedbackDisposition,
      reasoning: typeof o.reasoning === 'string' ? o.reasoning : '',
      suggestedChange: typeof o.suggestedChange === 'string' && o.suggestedChange.trim() ? o.suggestedChange : null,
    };
  }
  return null;
}

/** True iff there's a pr-feedback/v1 with no later feedback-eval/v1 (an evaluation is pending). */
export function feedbackEvalPending(activity: Activity[]): boolean {
  const comments = activity.filter((a) => a.type === 'comment');
  let lastFeedback = -1;
  let lastEval = -1;
  comments.forEach((a, i) => { if (isPrFeedback(a.body)) lastFeedback = i; if (isFeedbackEval(a.body)) lastEval = i; });
  return lastFeedback !== -1 && lastFeedback > lastEval;
}
