import type { AgentPromptKey } from './types.js';

/**
 * The configurable agent prompts, with UI labels/hints and display order. The `key`s MUST match
 * core's AGENT_PROMPT_KEYS — the client can't import core's runtime (node:sqlite), so this list is
 * the client-side mirror (labels/hints are a UI concern anyway).
 */
export const AGENT_PROMPT_FIELDS: { key: AgentPromptKey; label: string; hint: string }[] = [
  { key: 'worker.description', label: 'Worker · Description', hint: "Appended to the agent's system prompt when rewriting the feature description." },
  { key: 'worker.plan', label: 'Worker · Plan', hint: 'When writing the implementation plan.' },
  { key: 'worker.implementation', label: 'Worker · Implementation', hint: 'When writing code.' },
  { key: 'reviewer', label: 'Reviewer', hint: 'Extra instructions inlined into the AI code-review prompt.' },
  { key: 'delivering-evaluator', label: 'Delivering evaluator', hint: "How the agent critically evaluates a human's PR-review comment on a delivering task." },
];
