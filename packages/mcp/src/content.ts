import type { Core, TaskDetail } from './types.js';

type Block =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

/**
 * Task detail as tool-result content: the JSON text block followed by one image
 * block per spec attachment (the JSON's `attachments` metadata correlates them).
 * Claude-based runtimes pass image blocks to the model — the agent sees the pixels.
 */
export function detailContent(core: Core, task: TaskDetail): Block[] {
  const blocks: Block[] = [{ type: 'text', text: JSON.stringify(task, null, 2) }];
  for (const a of task.attachments) {
    const { bytes, mime } = core.getAttachment(a.id);
    blocks.push({ type: 'image', data: Buffer.from(bytes).toString('base64'), mimeType: mime });
  }
  return blocks;
}
