import type { Task } from './types.js';

/** Why Task Intelligence refuses to queue this task (the same wording core's 409 uses), or null. */
export function queueBlockMessage(task: Pick<Task, 'queueGate'>): string | null {
  if (task.queueGate?.action !== 'block') return null;
  return `Task Intelligence blocks queueing: ${task.queueGate.reasons.map((r) => r.message).join('; ')}`;
}
