import { isAiReviewMarker, isPrFeedbackMarker, isFeedbackEvalMarker, isIntakeMarker, isFailureTriageMarker } from '@agentfactory/core';
import type { AiReviewSummary, Task } from '@agentfactory/core';
import type { McpCore, TaskDetail } from './types.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Comments the implementing agent never sees: `ai-review/v1|v2` (uncurated reviewer findings),
 * the delivering-feedback markers `pr-feedback/v1` (the raw human PR comment) + `feedback-eval/v1`
 * (the evaluator's verdict), intake assessments, and failure-triage feedback. Only the
 * human-endorsed `feedback` activity (from request-changes / applyFeedbackFix) rides the re-claim.
 * Marker presence alone strips, so a malformed one can't slip through.
 */
const hiddenFromAgent = (body: string) =>
  isAiReviewMarker(body) || isPrFeedbackMarker(body) || isFeedbackEvalMarker(body) || isIntakeMarker(body) || isFailureTriageMarker(body);

/**
 * A task as an agent may see it — applied to every task-shaped payload the MCP tools return.
 * The derived operator views are nulled: `aiReview` and `reviewBrief` carry every uncurated
 * finding, and intake and failure triage are operator-facing only (the original failure/v1 note —
 * useful retry context — stays). The hidden marker comments are dropped from `activity`. The
 * board UI keeps all of it; this filter is MCP-only.
 */
export function forAgent<T extends Task>(task: T): T {
  const out: T = { ...task, aiReview: null, reviewBrief: null, intake: null, failureTriage: null };
  const activity = (task as Partial<TaskDetail>).activity;
  if (activity) (out as Partial<TaskDetail>).activity = activity.filter((a) => !(a.type === 'comment' && hiddenFromAgent(a.body)));
  return out;
}

/**
 * A review's verdict and finding count, with no finding content — what `list_tasks` keeps so an
 * MCP reviewer (/review-task) can tell which in-review tasks still need a review (none, or pending).
 */
export function verdictOnly(review: AiReviewSummary | null): AiReviewSummary | null {
  return review ? { verdict: review.verdict, findings: review.findings, reviewer: review.reviewer, items: [] } : null;
}

/**
 * Task detail as tool-result content: the JSON text block followed by one image
 * block per spec attachment (the JSON's `attachments` metadata correlates them).
 * Claude-based runtimes pass image blocks to the model — the agent sees the pixels.
 * `extra` is merged into the JSON object as sibling keys (e.g. the claim `protocol`),
 * keeping the task detail at the top level for back-compatible consumers.
 */
export async function detailContent(core: McpCore, task: TaskDetail, extra?: Record<string, unknown>): Promise<Block[]> {
  const detail = forAgent(task);
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
