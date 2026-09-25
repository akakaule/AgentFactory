import { isAiReviewMarker, isPrFeedbackMarker, isFeedbackEvalMarker, isIntakeMarker, isFailureTriageMarker } from '@agentfactory/core';
import type { Task } from '@agentfactory/core';
import type { McpCore, TaskDetail } from './types.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Advisory failure triage is operator-facing only: the derived label and its feedback markers
 * never reach a worker (spec §7). The original failure/v1 note — useful retry context — stays.
 * Applied to every task-shaped payload the MCP tools return.
 */
export function withoutFailureTriage<T extends Task>(task: T): T {
  const out: T = { ...task, failureTriage: null };
  const activity = (task as Partial<TaskDetail>).activity;
  if (activity) (out as Partial<TaskDetail>).activity = activity.filter((a) => !(a.type === 'comment' && isFailureTriageMarker(a.body)));
  return out;
}

/**
 * Task detail as tool-result content: the JSON text block followed by one image
 * block per spec attachment (the JSON's `attachments` metadata correlates them).
 * Claude-based runtimes pass image blocks to the model — the agent sees the pixels.
 * `extra` is merged into the JSON object as sibling keys (e.g. the claim `protocol`),
 * keeping the task detail at the top level for back-compatible consumers.
 *
 * Uncurated AI verdicts are stripped from the activity handed to the agent: `ai-review/v1`
 * (reviewer findings) and the delivering-feedback markers `pr-feedback/v1` (the raw human PR
 * comment) + `feedback-eval/v1` (the evaluator's verdict). Only the human-endorsed `feedback`
 * activity (from request-changes / applyFeedbackFix) rides the re-claim. (Marker presence alone
 * strips, so a malformed one can't slip through.) The board UI keeps them; this filter is MCP-only.
 * The derived `aiReview` summary is nulled for the same reason — its `items` carry every finding.
 */
export async function detailContent(core: McpCore, task: TaskDetail, extra?: Record<string, unknown>): Promise<Block[]> {
  const stripped = (b: string) => isAiReviewMarker(b) || isPrFeedbackMarker(b) || isFeedbackEvalMarker(b) || isIntakeMarker(b) || isFailureTriageMarker(b);
  const activity = task.activity.filter((a) => !(a.type === 'comment' && stripped(a.body)));
  const detail: TaskDetail = { ...task, activity, aiReview: null, intake: null, failureTriage: null };
  const payload = extra ? { ...detail, ...extra } : detail;
  const blocks: Block[] = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  for (const a of task.attachments) {
    // Best-effort: the claim is already committed by the time images hydrate, so a transient
    // attachment failure (e.g. a board 503 over HTTP) must degrade to text-only — failing the
    // whole tool call here stranded the claim and made the agent's retry grab a SECOND task.
    try {
      const { bytes, mime } = await core.getAttachment(a.id);
      blocks.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mime });
    } catch {
      blocks.push({ type: 'text', text: `[attachment ${a.id} (${a.filename}) could not be fetched — refer to the spec text]` });
    }
  }
  return blocks;
}
