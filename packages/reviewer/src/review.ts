import type { TaskDetail, BranchDiff } from '@agentfactory/core';
import { isAiReviewMarker, parseAiReviewComment } from '@agentfactory/core';
import type { ReviewEngine } from './config.js';

const DEFAULT_MAX_DIFF_CHARS = 120000;

/** Latest result-activity body — the author's own summary of the deliverable (verify, don't trust). */
function latestResult(task: TaskDetail): string {
  const last = task.activity.filter((a) => a.type === 'result').at(-1);
  return last?.body || '(no result summary recorded)';
}

/** Truncate a diff to maxDiffChars (0 = no limit), flagging the cut in-band so the engine says so. */
export function truncateDiff(diff: string, maxDiffChars: number): string {
  if (maxDiffChars > 0 && diff.length > maxDiffChars) {
    return (
      diff.slice(0, maxDiffChars) +
      `\n... (diff truncated at ${maxDiffChars} chars; flag that you reviewed a partial diff in your summary)`
    );
  }
  return diff;
}

/** The strict ai-review/v1 output contract every prompt ends with (matches core's parser). */
function outputContract(engine: ReviewEngine): string {
  return [
    'Respond with EXACTLY this structure and nothing else - no preamble, no trailing commentary:',
    '',
    `ai-review/v1 - <N> findings (${engine})`,
    '<one short paragraph summarising the review>',
    '```json',
    '{',
    `  "reviewer": "${engine}",`,
    '  "verdict": "clean" | "findings",',
    '  "findings": [',
    '    { "severity": "error" | "warning" | "info", "file": "<path or omit>", "line": <number or omit>,',
    '      "title": "<short title>", "detail": "<why it matters / what to change>" }',
    '  ]',
    '}',
    '```',
    '',
    `With zero findings: first line 'ai-review/v1 - clean (${engine})', verdict "clean", findings [].`,
  ].join('\n');
}

/** Implementation-stage prompt: review the branch diff against the brief. */
function implementationPrompt(
  task: TaskDetail,
  engine: ReviewEngine,
  branch: string,
  diff: BranchDiff,
  maxDiffChars: number,
): string {
  return [
    'You are an automated first-pass code reviewer for a task board. A human reviews after you;',
    'your verdict is advisory and your findings will be curated by that human. Review the diff',
    "below against the task's brief. Report only findings you are confident matter: correctness",
    'against the acceptance criteria first, then real bugs, security issues, or broken conventions',
    'visible in the diff. Do not pad; zero findings is a perfectly good verdict. Severity:',
    '"error" = will not meet the brief / breaks something, "warning" = likely problem worth a look,',
    '"info" = worth knowing, not blocking.',
    '',
    outputContract(engine),
    '',
    `=== TASK ${task.key}: ${task.title} ===`,
    '',
    '=== SPEC ===',
    task.spec,
    '',
    '=== ACCEPTANCE CRITERIA ===',
    task.acceptanceCriteria,
    '',
    "=== SUBMITTED RESULT (implementer's own summary - verify, don't trust) ===",
    latestResult(task),
    '',
    '=== BRANCH ===',
    `${branch} (${diff.commits} commit(s) vs ${diff.baseRef})`,
    '',
    '=== DIFF ===',
    truncateDiff(diff.diff, maxDiffChars),
  ].join('\n');
}

/** Doc-stage prompt (description/plan): the deliverable is the task's own fields, not a diff. */
function docPrompt(task: TaskDetail, engine: ReviewEngine): string {
  let charge: string;
  let deliverable: string[];
  if (task.stage === 'description') {
    charge = [
      "Review the FEATURE DESCRIPTION below (spec + acceptance criteria) against the task's",
      "intent (title, source links in the spec, the author's summary). Is the description",
      'complete and unambiguous? Are the acceptance criteria objectively verifiable? Does it',
      'invent scope the source never asked for? "error" = the description fails its purpose',
      '(wrong or missing intent, unverifiable criteria), "warning" = a gap worth a look,',
      '"info" = worth knowing, not blocking.',
    ].join('\n');
    deliverable = [
      '=== SPEC (the deliverable under review) ===',
      task.spec,
      '',
      '=== ACCEPTANCE CRITERIA (the deliverable under review) ===',
      task.acceptanceCriteria,
    ];
  } else {
    charge = [
      "Review the IMPLEMENTATION PLAN below against the task's spec and acceptance criteria.",
      'Does the plan cover every acceptance criterion? Is it concrete (files, approach, test',
      'plan) and plausible for the codebase it names? "error" = the plan would not deliver',
      'the spec, "warning" = a gap worth a look, "info" = worth knowing, not blocking.',
    ].join('\n');
    deliverable = [
      '=== SPEC ===',
      task.spec,
      '',
      '=== ACCEPTANCE CRITERIA ===',
      task.acceptanceCriteria,
      '',
      '=== IMPLEMENTATION PLAN (the deliverable under review) ===',
      task.plan ?? '(no plan recorded)',
    ];
  }
  return [
    `You are an automated first-pass reviewer for a task board. This task is at its ${task.stage}`,
    'stage. A clean verdict from you advances the task to its next stage automatically;',
    'findings escalate to a human.',
    charge,
    'Do not pad; zero findings is a perfectly good verdict.',
    '',
    outputContract(engine),
    '',
    `=== TASK ${task.key}: ${task.title} ===`,
    '',
    ...deliverable,
    '',
    "=== AUTHOR'S SUMMARY (verify, don't trust) ===",
    latestResult(task),
  ].join('\n');
}

export interface ReviewPromptInput {
  task: TaskDetail;
  engine: ReviewEngine;
  /** Implementation stage: the feature branch name and its merge-base diff. */
  branch?: string | undefined;
  diff?: BranchDiff | undefined;
  maxDiffChars?: number | undefined;
}

/**
 * Build the per-stage review prompt. Implementation reviews the branch diff; description and
 * plan stages review the task's own deliverable fields. Every prompt ends in the strict
 * `ai-review/v1` output contract.
 */
export function buildReviewPrompt(input: ReviewPromptInput): string {
  const { task, engine, branch, diff, maxDiffChars = DEFAULT_MAX_DIFF_CHARS } = input;
  if (task.stage === 'implementation') {
    if (!branch || !diff) throw new Error(`implementation review needs a branch + diff for ${task.key}`);
    return implementationPrompt(task, engine, branch, diff, maxDiffChars);
  }
  return docPrompt(task, engine);
}

/**
 * Guarantee the posted body carries the `ai-review/v1` marker core's parser keys on. The
 * engines are instructed to emit it; this is the safety net for one that forgets — it derives
 * the findings count by parsing a temporarily-marked copy so the prepended header is accurate.
 */
export function ensureMarker(body: string, engine: ReviewEngine): string {
  const trimmed = body.trim();
  if (isAiReviewMarker(trimmed)) return trimmed;
  const parsed = parseAiReviewComment(`ai-review/v1\n${trimmed}`);
  const n = parsed ? parsed.findings.length : 0;
  const head = n === 0 ? `ai-review/v1 - clean (${engine})` : `ai-review/v1 - ${n} findings (${engine})`;
  return `${head}\n${trimmed}`;
}
