# Consensus task review

Status: approved by the user and implemented behind the consensus setting.

## Purpose

Replace the union of independent reviewer findings with an evidence-based agreement process. Keep the configured reviewers: Claude Fable (`claude-fable-5-1`) and GPT-6 Astra (`gpt-6-astra`, medium). More reviewers can use the same protocol later; the initial configuration remains two.

The current `ReviewRound` collects each response and concatenates all findings, including duplicates. There is no cross-examination or agreement. The task checklist now shows only `error` severity findings, but visibility filtering does not establish agreement.

## Proposed workflow

1. **Independent review.** Each model reviews the same frozen submission without seeing the other's conclusions. Preserve the current sequential scheduling initially; independence does not require concurrent execution.
2. **Cross-examination.** Give both reviewers the complete candidate set, stable finding IDs, source evidence, and the same submission. Each evaluates every candidate as confirm, reject, or uncertain, with reasons and code references. Findings missed in the initial pass can be confirmed here. Never count silence or omitted IDs as agreement.
3. **Discussion and final ballot.** When evaluations differ, allow one rebuttal exchange. Both reviewers receive the same collected responses before making final decisions. Confirming means accepting the concrete defect, its applicability to this submission, and its severity. Agreement is not an instruction to compromise or manufacture objections. If cross-examination is already unanimous, skip this phase.
4. **Publish once.** Produce one final consensus review only after all required validated responses arrive. Present confirmed high-priority findings once, with model confirmation badges and supporting evidence. Keep individual reviews, rebuttals, rejected candidates, and lower-priority conclusions in expandable history.

For two reviewers, confirmation requires both. A third reviewer is not needed for the initial implementation. Unanimously rejected candidates are removed. Mixed votes, uncertainty, or a disagreement about high priority remain disputed. A candidate first introduced during the final ballot is unresolved until independently evaluated; it cannot become a confirmed finding through one model's assertion.

## Findings and duplicates

Assign deterministic candidate IDs before discussion; ballots must reference known IDs exactly once. Both models judge the exact same immutable candidate text. Rewording that materially changes the claim creates a new candidate requiring confirmation. Models may propose duplicate groups, but grouping requires agreement that the root cause, affected behavior, and remedy match. Keep separate findings if that agreement is absent. Retain all source IDs behind any merged presentation.

## Disagreement and lifecycle

Show disputed high-priority candidates in a separate collapsed “Needs human decision” section, excluded from the agreed-finding checklist and automatically composed request-changes feedback. A finished disputed review is a valid outcome, not a CLI failure and not a reason to retry endlessly. Human review remains available.

The core currently derives clean solely from an empty findings array. Introduce a versioned final `ai-review/v2` contract with explicit consensus status, participants, candidate decisions, and confirmed findings. Extend the derived verdict with `disputed`. A review can contain confirmed findings and disputes simultaneously; retain both in the summary. A clean verdict requires completed unanimous evaluation with no confirmed findings and no unresolved candidates. Confirmed lower-priority findings remain stored under existing findings semantics, even though they are not listed in the high-priority checklist.

Update the core parser, document-stage advancement hook, approval audit, metric interpretation, MCP review stripping, API types, and reviewer polling together. Malformed v2 output must never downgrade into clean. Legacy v1 reviews retain existing behavior. Individual and intermediate agent responses are not posted as lifecycle-driving AI reviews. An unresolved result must never auto-advance a description or plan task.

## Snapshot, bounds, and recovery

Pin the implementation review to immutable head/base commits, not just a mutable branch name or task result ID. All inspection prompts use those revisions. Retain the existing task fingerprint and reject publication if the submission or reviewed revision changes. Carry the current execution identity where supported; do not bypass the task's execution fencing.

Add optional `consensus` configuration with `enabled`, one bounded rebuttal round, and a finite total deadline (proposed default 30 minutes per task attempt). Keep `reviewMinutes` as the per-session ceiling, capped by time remaining in the overall deadline. Preserve existing concurrency and retry limits. No new agent session may start after the total budget expires. A CLI failure, timeout, or malformed ballot remains an execution failure, never consensus. Preserve completed evidence in logs with task, attempt, phase, candidate, and model identity. A supervisor restart may safely restart the whole attempt against a fresh snapshot; resumable discussion is outside the first increment.

Typically this takes four model sessions per task, or six when rebuttal is needed, compared with two today. Actual tokens and API-equivalent cost depend on context length and model behavior; do not promise a fixed cost multiplier. Attribute each session by model and phase for the token-breakdown work.

## Rollout

Implement behind an opt-in setting. Verify legacy and consensus flows with isolated fixtures, then deploy compatible core/web/reviewer builds before enabling consensus. Do not interrupt active reviews. Prove one actual Claude/Astra consensus cycle on a disposable task without external publishing or automatic real-task approval. Enable new reviews after validation; historical reviews remain unchanged unless explicitly rerun.
