import type { AgentPromptKey } from './types.js';

/**
 * The configurable agent prompts, with UI labels/hints, an editable example starter, and display
 * order. The `key`s MUST match core's AGENT_PROMPT_KEYS — the client can't import core's runtime
 * (node:sqlite), so this list is the client-side mirror (labels/hints/examples are a UI concern).
 */
export const AGENT_PROMPT_FIELDS: { key: AgentPromptKey; label: string; hint: string; example: string }[] = [
  {
    key: 'worker.description',
    label: 'Worker · Description',
    hint: "Appended to the agent's system prompt when rewriting the feature description.",
    example:
      "Rewrite the raw request into a precise, testable feature description. Preserve the original intent and any linked source (work item / ticket) — never invent scope it doesn't ask for. State the problem, the desired behaviour, and explicit acceptance criteria where each is an objectively checkable observation, not a vague goal. Surface ambiguities instead of guessing. No implementation detail; keep it tight.",
  },
  {
    key: 'worker.plan',
    label: 'Worker · Plan',
    hint: 'When writing the implementation plan.',
    example:
      "Produce a concrete plan that covers every acceptance criterion. Name the specific files/functions to change and the approach for each; prefer the smallest viable change that reuses existing patterns over new abstractions. List the tests you'll add or update, and call out risks, edge cases, and any migration steps. If a criterion can't be met as written, say so.",
  },
  {
    key: 'worker.implementation',
    label: 'Worker · Implementation',
    hint: 'When writing code.',
    example:
      "Write the simplest change that satisfies the acceptance criteria and touch only what's necessary. Match the surrounding code's style. Use TDD where it fits — a failing test first, then make it pass. Never weaken types, swallow errors, or leave a TODO in place of a real fix. Run the workspace verify command and get it green before submitting; if you deviate from the plan, explain why in the result summary.",
  },
  {
    key: 'reviewer',
    label: 'Reviewer',
    hint: 'Extra instructions inlined into the AI code-review prompt.',
    example:
      "Review strictly against the acceptance criteria first, then for real correctness, security, and concurrency bugs visible in the diff. Report only findings you're confident matter — no style nitpicks, no praise, no padding; zero findings is a valid verdict. For each finding give a concrete failure scenario (inputs → wrong result) and the specific fix. Verify the result summary's claims against the actual diff instead of trusting them.",
  },
  {
    key: 'delivering-evaluator',
    label: 'Delivering evaluator',
    hint: "How the agent critically evaluates a human's PR-review comment on a delivering task.",
    example:
      "You are a skeptical evaluator, not an agreeable one. Decide whether the reviewer's comment identifies a real problem in this specific diff that warrants a code change. Reviewers are sometimes mistaken, stylistic, or out of scope — say so. Judge only against the diff and the acceptance criteria. 'warranted' = a concrete correct change is justified; 'partial' = only part of it; 'not_warranted' = it should not drive a change (explain why). When warranted, state the minimal change to make.",
  },
];
