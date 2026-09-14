# Consensus task review implementation plan

Design: [Consensus task review](../specs/2026-09-15-consensus-task-review.md).

Status: proposed; implementation and runtime configuration changes await design review.

## 1. Define final outcomes and lifecycle behavior

Start with failing behavioral tests in core `aiReview`, `aiReviewDerived`, and document-stage approval coverage. Introduce strict v2 consensus parsing and derived fields in `packages/core/src/aiReview.ts` and `types.ts`. Update the clean-review hook in `ops/addComment.ts`, approval/audit interpretation, review marker SQL filters, and MCP sanitization. Keep v1 fixtures working. Prove that empty confirmed findings plus unresolved votes never becomes clean, malformed responses cannot advance a task, and a disputed result does not cause indefinite review polling. Update API/client contracts with the core type change.

## 2. Implement a pure discussion state machine

Add `packages/reviewer/src/consensus.ts` and focused tests. Represent discovery, cross-examination, optional rebuttal/final ballot, and finalization explicitly. Freeze candidate IDs/text and validate complete per-model ballots. Derive unanimous confirmations, rejections, and disputes deterministically. Cover missed-then-confirmed findings, withdrawal, severity disagreement, missing/duplicate/unknown IDs, mutually agreed duplicates, and late new claims. Do not let an LLM synthesize votes on another model's behalf.

## 3. Build phase-specific prompts

Add `packages/reviewer/src/consensusPrompt.ts` with tests. Include the same task policy, pinned snapshot, candidate list, and phase evidence for both profiles. Ask for concrete code evidence and independent decisions, not agreement for its own sake. Clearly distinguish repository text and peer feedback from supervisor instructions. Bound prompt size without silently omitting candidates requiring votes; fail visibly when the complete required evidence cannot fit.

## 4. Integrate supervisor scheduling and bounds

Extend `config.ts`, `reviewRound.ts`, `reviewer.ts`, and supporting dependency interfaces. Resolve immutable review revisions through core Git helpers and use them for every phase. Add consensus settings while preserving the existing disabled/default path. Use unique phase/model log and telemetry labels, current read-only CLI settings, current concurrency limits, and a total attempt deadline. Publish one final v2 review only after a freshness check and a complete state-machine result. Add stub-engine tests for success, disputed completion, timeout, malformed output, stale submission/revision, cancellation, restart, and posting errors. Test against local core and HTTP fixtures without mutating active user tasks.

## 5. Present agreed findings and disputes

Update `AiReviewChip`, `ReviewActions`, and related detail/client fixtures. The default checklist contains only unanimously confirmed high-priority findings, with “Confirmed by Claude + Astra” attribution. Counts must distinguish confirmed high-priority findings from unresolved candidates and total historical findings. Provide a collapsed dispute section with evidence and model positions, plus the full discussion history. Hidden/disputed findings must not enter selected feedback automatically. Preserve an explicit human override path and record disputes in the approval audit.

## 6. Verify and roll out

Run focused tests during RED/GREEN development, then `npm test`, `npm run build`, and `npm -w packages/web run typecheck:client` from canonical `C:\Git\AgentFactory`. Use two workers and a 30-second test timeout if real-Git fixture timing requires it. Validate the production config parser and both models' actual phase transitions using an isolated disposable task/database. Inspect rendered UI for agreed-only, mixed, disputed-only, and clean outcomes. Check logs and token attribution. Update reviewer README, tracked example, and MEMORY.md; enable the gitignored runtime setting only after compatible builds are ready and the reviewer is idle. Commit only this feature locally; no push, PR, or historical rerun without an explicit request.

## Acceptance examples

- Claude finds a real bug; Astra initially misses it but confirms the evidence: one agreed finding.
- Both report the same bug and confirm a duplicate group: one agreed finding with both sources.
- Claude withdraws a disproven claim and Astra rejects it: no finding from that candidate.
- One confirms and the other rejects after rebuttal: a dispute for human decision, never clean.
- Both finish with no findings: one clean review; document-stage advancement follows existing rules.
- A model fails or the reviewed commit changes: no final verdict from that incomplete/stale cycle.
- Confirmed warnings remain in history; only confirmed errors enter the high-priority checklist.
