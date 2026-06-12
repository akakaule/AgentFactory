import { isAiReviewMarker } from '@agentfactory/core';
import type { Core, TaskDetail } from './types.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Task detail as tool-result content: the JSON text block followed by one image
 * block per spec attachment (the JSON's `attachments` metadata correlates them).
 * Claude-based runtimes pass image blocks to the model — the agent sees the pixels.
 * `extra` is merged into the JSON object as sibling keys (e.g. the claim `protocol`),
 * keeping the task detail at the top level for back-compatible consumers.
 *
 * `ai-review/v1` comments are stripped from the activity handed to the agent: uncurated
 * reviewer findings must not leak into the implementer's brief — only the human-curated
 * `feedback` activity rides the re-claim. (Marker presence alone strips, so a malformed
 * review can't slip through.) The board UI keeps them; this filter is MCP-only.
 */
export function detailContent(core: Core, task: TaskDetail, extra?: Record<string, unknown>): Block[] {
  const activity = task.activity.filter((a) => !(a.type === 'comment' && isAiReviewMarker(a.body)));
  const detail: TaskDetail = { ...task, activity };
  const payload = extra ? { ...detail, ...extra } : detail;
  const blocks: Block[] = [{ type: 'text', text: JSON.stringify(payload, null, 2) }];
  for (const a of task.attachments) {
    const { bytes, mime } = core.getAttachment(a.id);
    blocks.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mime });
  }
  return blocks;
}
