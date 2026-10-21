# Review decision panel: implementation plan

**Spec:** [docs/spec/2026-10-21-review-decision-panel-design.md](../spec/2026-10-21-review-decision-panel-design.md)
**Branch:** `feat/review-decision-panel`, stacked on `feat/default-flow-spec-to-pr` (PR #65, still
open). Rebase onto `main` once #65 merges.
**Baseline:** 171 test files, 1705 tests green; `npm run build` green.

## Adjustments to the spec's slicing

Reading the code turned up three changes to §9. None changes behaviour the spec describes.

1. **The core half of slice 4 moves into slice 1.**
   - What moves: the `AiReviewFinding` fields, `normalizeFinding`, and the strict
     `consensusFindingSchema` / `consensusVoteSchema` additions.
   - Why: `buildReviewBrief` reads `finding.criteria`, `finding.fix` and `vote.reason`, and the
     candidate types are inferred from those zod schemas.
   - Side benefit: this is also the safe deploy order (§8), with the board accepting the keys before
     any reviewer emits them.
   - Slice 4 becomes reviewer-package-only (`newFindingSchema` and the prompts).
2. **The shared MCP sanitizer also strips marker comments from `activity`.**
   - Two task-shaped payloads go through `withoutFailureTriage` and carry `activity`:
     `submit_result` returns the full `TaskDetail`, and `update_status` does too.
   - Today that activity keeps older `ai-review/v1|v2`, `pr-feedback/v1`, `feedback-eval/v1` and
     `intake/v1` comments.
   - Fix: the sanitizer applies the same marker filter `detailContent` applies, and nulls
     `aiReview`, `reviewBrief` and `intake`. It is renamed `forAgent`, because it now does more than
     failure triage.
   - This is the §7 gap, closed the same way for every tool.
3. **Order: 1 → 2 → 4 → 5 → 3.** The UI lands last, so it ships against the final contract: fix,
   reason and claims. Slices 1–2 already work on today's data, as the spec says.

Each slice is one commit (Conventional Commits). Each runs RED → GREEN on its focused tests, then
`npm test`, `npm run build` and `npm -w packages/web run typecheck:client`.

## Slice 1: core read model

**`acceptanceCriteria.ts`** (new). `parseAcceptanceCriteria(text)` per spec §4.1.
- Line scanner: detect list lines (`1.`, `1)`, `-`, `*`, `•`, `- [ ]`, `- [x]`), using the first
  item's indent as the item level.
- Deeper or continuation lines join the current item.
- A blank line followed by a non-list line closes the item, and the paragraph goes to `general`.
- Name: the prefix before the first ` — `, ` – `, ` - ` or `: `, when it is 1–48 characters. The
  list marker is stripped from `text`.
- Text with no list gives a single AC1; empty text gives no items.

**`types.ts`.**
- `AiReviewFinding.criteria?` and `fix?`.
- `ReviewHeadline`, `ReviewGroup`, `ReviewDispute`, `ReviewOpinion`, `ReviewIssue`,
  `ReviewCriterionRow`, `ReviewBrief`.
- `Task.reviewBrief: ReviewBrief | null`.

**`aiReview.ts`.** `normalizeFinding` keeps `criteria` (uppercase, dedupe, `/^AC\d+$/`, at most 10,
`[]` kept, a non-array omitted) and a non-empty `fix`.

**`reviewConsensus.ts`.**
- `consensusFindingSchema` gains `criteria` (an array of `/^AC\d+$/`, at most 10) and `fix`, both
  optional.
- `consensusVoteSchema` gains `reason` (optional, nullable, at most 300 characters).
- The `consensusFindings` → `consensusFindingSchema.parse` round trip keeps the new keys: zod emits
  shape order and drops absent optional keys, so stored comments still compare equal.

**`reviewBrief.ts`** (new). `buildReviewBrief(review, acceptanceCriteria, stage)` per spec §5:
- v2 walk: rejected, duplicate roots, group table, raise-by-merge, criteria union with the title
  fallback, severity from votes;
- v1 mapping;
- headline;
- criteria rows (implementation stage only);
- `unlinked`.

**`repo/tasks.ts`.** `toTask` defaults `reviewBrief: null`. `listRows` and `toDetail` attach
`buildReviewBrief(aiReview, row.acceptance_criteria, row.stage)`.

**`index.ts`.** Export `parseAcceptanceCriteria` and `buildReviewBrief`, plus their types (the types
come through `export *`).

**MCP `content.ts`.**
- `detailContent` nulls `reviewBrief`.
- The `withoutFailureTriage` → `forAgent` rename and marker strip (adjustment 2), with call sites in
  `listTasks`, `submitResult` and `updateStatus`.

**Tests.**
- `core/test/acceptanceCriteria.test.ts`: AF-146 text, nested bullets and continuations, checkboxes,
  `1)` numbering, no-list text, empty text, names over 48 characters.
- `core/test/reviewBrief.test.ts`:
  - the AF-146 fixture (`core/test/fixtures/review-brief/af146-round3.json`) for both legacy links
    and reviewer-reported links;
  - synthetic validity, unverified, rejected-root duplicate and raise-by-merge cases;
  - v1, pending and clean reviews.
- `core/test/aiReview.test.ts` and `consensusReview.test.ts`: new keys survive, and old fixtures
  parse unchanged.
- `core/test/listTasks.test.ts` / `getTask.test.ts`: `reviewBrief` is attached.
- `mcp/test/tools.test.ts`: `get_next_task`, `get_task`, `list_tasks` and `submit_result` payloads
  carry `aiReview: null` and `reviewBrief: null`, with no ai-review comments in `activity`.

**Fixture.** Build it from activity 2989:
- keep the participants, candidates and submission (fingerprint shortened);
- keep one short history entry per phase;
- regenerate `findings` with `consensusFindings`.

The reviewer-reported variant adds `criteria` per §5.5.

## Slice 2: approve with a reason

- **`ops/approval.ts`.**
  - `applyApproval(…, overrideReason: string | null = null)` builds the brief inside the
    transaction.
  - A human approve with headline `changes_needed` or `your_call` and a blank reason throws
    `ValidationError`.
  - The override comment body is `override: approved over …` (non-zero parts) plus
    `\n\nReason: …`.
- **`ops/reviewApprove.ts`.** Add `overrideReason?: string`. The `createCore` binding becomes
  `reviewApprove: (key, actorUserId = null, overrideReason?)`.
- **`web/server/schemas.ts`.** `approveBody = z.object({ reason: z.string().trim().min(1).max(2000).optional() })`.
  An absent or empty body stays valid, because existing callers post `{}`.
- **`routes/tasks.ts`.** Parse the optional body and pass the reason.
- **Client `api.ts`.** `approve(key, reason?)`.
- **Tests.**
  - Extend `core/test/reviewApprove.test.ts`:
    - must-fix without a reason → 400-class `ValidationError`, task still `in_review`;
    - with a reason → approved, and the comment carries `Reason:`;
    - minor-only → no reason needed, override comment written;
    - clean and pending → unchanged;
    - `findingsAtApproval` unchanged.
  - Server route test in `web/test/server/tasks.test.ts`: 400 and success.

## Slice 4: reviewer output

- **`reviewer/src/consensus.ts`.** `newFindingSchema` gains nullable, optional `criteria` and `fix`,
  normalized like `normalizeFinding` before they become candidates.
- **`reviewer/src/review.ts`.**
  - The implementation prompt lists `AC<n>. <text>` and `Also required:` when parsing finds items.
  - The output contract becomes `{ severity, file, line, title, criteria, detail, fix }` with the
    field guidance.
  - The description prompt is unchanged: there, the criteria are the deliverable.
- **`reviewer/src/consensusPrompt.ts`.** The vote shape adds `reason`, and `newFindings` adds
  `criteria` and `fix`.
- **Tests.** `reviewer/test/review.test.ts`, `consensusPrompt.test.ts`, `consensus.test.ts` and
  `consensusFlow.test.ts`. A v1 finding with `criteria`/`fix` and a ballot `reason` survive to the
  posted `ai-review/v2` comment and `parseAiReviewComment`.

## Slice 5: worker claims

- **Core.**
  - `criteriaClaims.ts` (new): `CRITERIA_CLAIMS_MARKER`, `isCriteriaClaimsMarker`,
    `buildCriteriaClaimsComment` and `parseCriteriaClaims`.
  - `validate.ts`: `submitResultSchema.criteria` (`{ id: /^AC\d+$/, claim: 1–600 }[]`).
  - `types.ts`: `SubmitResultInput.criteria?` and `TaskDetail.criteriaClaims`.
  - `ops/submitResult.ts`: `assertStageShape` rejects `criteria` on doc stages; the ids are
    validated against the parser; the comment is appended after the `result` row.
  - `repo/activity.ts`: `criteriaClaimsFor(db, taskId)`, a dedicated query that only reads claims
    newer than the latest result.
  - `toDetail` attaches it.
- **MCP.**
  - `submit_result` gains the `criteria` input and description text.
  - `protocol.ts`: `PROTOCOL_VERSION = 8`; implementation `ProtocolInput.criteria`; the finish-step
    wording; the description-stage numbered-list sentence.
  - `getNextTask.ts` fills `criteria` from the parser.
- **Client.** `ActivityItem` renders a claims comment as "Reported on N acceptance criteria" with a
  `<details>`.
- **Tests.** `core/test/submitResult.test.ts`, `mcp/test/protocol.test.ts` and
  `mcp/test/tools.test.ts`.

## Slice 3: review panel (client)

- **`reviewText.ts`.**
  - `reviewerShortName(s)` and `shortNames(list)`, with a collision fallback.
  - `headlineTitle`, `reviewSentence(brief)`, group and decision labels.
- **`composeReviewFeedback.ts`.** Builds the body per §6.7 from the brief, the decisions and the
  note.
- **Components.**
  - `ReviewPanel.tsx`: verdict card, pills and filters, meta line, actions, hint. It holds the
    decisions state, keyed by review signature.
  - `ReviewCriteria.tsx`: strip and table, row expand and filter, general criteria, unlinked line.
  - `ReviewIssueCard.tsx`: badge, title, chips, problem and fix, merged note, agreement and
    opinions, decision radio group.
  - `ReviewEvidence.tsx`: right-hand panel; criteria, claims, diff hunk (`api.getDiff` +
    `parseUnifiedDiff`), opinions, merged.
  - `ReviewSendBack.tsx` and `ReviewApprove.tsx`: dialogs (`role="dialog"`, `aria-modal`, Esc,
    focus return).
- **Existing components.**
  - `AiReviewChip.tsx` takes the brief.
  - `TaskCard.tsx` adds the criteria strip.
  - `ConsensusDiscussion.tsx` is reduced to the raw discussion.
  - `ReviewActions.tsx` is cut to pr-review only.
  - `DetailPanel.tsx`: the review panel goes in column 1, the raw criteria are hidden while the
    table shows, and "Worker's summary" moves to the top of column 2.
  - `index.css` / `board.css`: `af-rv-*` classes using the existing tokens, with stacking at
    narrow width.
- **Tests** in `web/test/client/`. They build briefs with core's `buildReviewBrief` from the AF-146
  fixture.
  - Chip per headline, and the strip.
  - Panel order, preselection, hint, pending read-only.
  - Evidence hunk and the not-changed messages.
  - Send-back body and not-sent list.
  - Approve dialog: reason required, 400 shown inline.
  - The code-task cases move out of `ReviewActions.test.tsx` and `consensusReview.test.tsx`;
    `reviewActionsPrReview.test.tsx` is unchanged.
- **Manual.** Run `web:dev:server` + `web:dev` against a temp copy of the board DB, and open AF-146
  (in review, v2 review).

## Done when

- The spec §10 acceptance criteria pass.
- The full suite, build and client typecheck are green.
- One `/code-review` pass is done on the branch, and its verified findings are fixed.
- The deploy notes (spec §8) are in the PR body.
