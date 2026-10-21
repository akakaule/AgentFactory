# Review decision panel: understand the AI review before deciding

**Date:** 2026-10-21
**Status:** Draft, awaiting approval
**Mockup:** [Review Feedback Redesign](https://claude.ai/artifact/6czqT2DZg44Wym3VgyRDdj) (private
canvas, built from AF-146's round-3 review)
**Assumes:** PR #65 (default flow) is merged, so a description-stage approval advances to
implementation.

## 1. Problem

The human review gate shows the AI review as counts and a checklist. It doesn't answer the question
the human has: is this ready, and if not, what's wrong? AF-146's round-3 review (commit 4699e45,
Claude + Codex, 9 consensus candidates) shows each gap.

| The drawer shows | The review actually says |
|---|---|
| Chip: "2 agreed high-priority · 4 disputed · 2 other confirmed" | Both reviewers confirmed every candidate. Two are duplicates (F7 of F1, F9 of F3), so there are 7 distinct issues. The 4 "disputes" are 3 severity disagreements plus F9, the duplicate. |
| A checklist of 2 high-priority findings | The 2 agreed warnings (F2, F4) aren't in the checklist, so "Request changes" can't send them. The 3 severity disputes sit in a read-only `<details>` and can't be sent either. |
| Findings by title and file | Nothing ties a finding to the criterion it puts at risk. AC4 (Race) and AC6 (Liveness) aren't met, but the human has to work that out by mapping 9 findings onto 8 criteria. |
| The result summary, further down | The worker's claim for each criterion is free text, far from the finding that contradicts it. |
| "Override — approve anyway (8)" | 8 is 4 findings plus 4 disputes, which counts F3 and its duplicate F9 separately. No reason is recorded with the override. |

Two more problems:

- A finding's `detail` mixes the problem with the fix.
- The only explanation of a severity disagreement is in each vote's `evidence`, a long paragraph of
  code references.

## 2. Goals and non-goals

Goals: before deciding, the human can see in one place:

1. a plain verdict: changes needed, your call, minor issues only, no issues found, or review
   pending;
2. which acceptance criteria are at risk, with the worker's claim next to what the reviewers found;
3. each distinct issue once, with duplicates merged and the problem kept separate from the fix;
4. where the reviewers disagree, and each side's reason;
5. the code a finding points at, one click away;
6. exactly what the agent will get, before sending the task back;
7. which criteria stay unmet when approving over open issues, with a reason recorded.

Non-goals:

- Changing how reviewers reach consensus (phases, votes, `candidateOutcome`).
- Changing the override-rate KPI (`findingsAtApproval`). See §4.4.
- Persisting the human's per-issue decisions anywhere except the send-back body, or feeding
  dismissals into the next review round.
- pr-review tasks keep today's `ReviewActions` ("Mark reviewed" and the PR body editor). Only their
  card chip changes.
- The mockup's review-round number and history summary. Both need new derivations and neither helps
  the decision.

## 3. Overview

```
reviewer prompt lists criterion ids; findings carry criteria + fix; votes carry a reason
  → ai-review/v1 or v2 comment            (optional new fields, same markers)
worker submit_result { …, criteria: [{ id, claim }] }
  → criteria-claims/v1 comment            (new marker, implementation stage only)
core buildReviewBrief(aiReview, acceptanceCriteria, stage)   (pure, at read time)
  → Task.reviewBrief                      (list and detail; nulled in MCP payloads)
web: card chip · review panel · evidence · send-back dialog · approve dialog
  → request-changes (composed body) | approve { reason } (core enforces the reason)
```

Everything is still derived from the activity log. There is no migration.

## 4. Data contracts

### 4.1 Acceptance criterion ids

New `packages/core/src/acceptanceCriteria.ts`:

```ts
export interface AcceptanceCriterion { id: string; name: string | null; text: string }
export interface ParsedCriteria { items: AcceptanceCriterion[]; general: string | null }
export function parseAcceptanceCriteria(text: string): ParsedCriteria;
```

Rules:

- **Items.** An item starts at a list line: numbered (`1.`, `1)`) or a bullet (`-`, `*`, `•`,
  `- [ ]`, `- [x]`), indented no deeper than the first item.
- **What belongs to an item.** More deeply indented lines (nested bullets) and non-blank
  continuation lines belong to the current item. A blank line followed by a non-list line ends the
  item.
- **Ids are positional.** Items get `AC1`…`ACn` in order of appearance, whatever numbers the author
  typed. The reviewer prompt, the worker protocol and the UI all get their ids from this one parser,
  so they always agree.
- **Name.** `name` is the text before the first ` — `, ` – `, ` - ` or `: `, if that prefix is 1–48
  characters (AF-146: "Stale fence", "Race"). Otherwise it is null.
- **Text.** `text` is the whole item, trimmed, name included. Internal line breaks are kept.
- **Text without a list.** Non-empty text with no list items becomes a single `AC1` holding all of
  it. Empty text gives no items.
- **General text.** Non-list paragraphs go to `general`, joined by a blank line. This covers intros
  such as "Done when:" and cross-cutting rules such as AF-146's closing "Each item is covered by an
  automated test…".

The description stage's protocol step gets one more sentence so new criteria parse cleanly: "Write
the acceptance criteria as a numbered list, one verifiable criterion per item, each starting with a
short name and a dash (`4. Race — two supervisors …`)."

### 4.2 Reviewer output: criteria, fix and reason

Findings (the v1 contract and v2 candidates) get two optional fields:

| Field | Type | Meaning |
|---|---|---|
| `criteria` | `string[]`, each `/^AC\d+$/`, at most 10 | The criteria this finding puts at risk. `[]` means it is outside the criteria. Absent means not reported (legacy). |
| `fix` | `string` | The change that resolves the finding. `detail` now holds only the problem. |

Ballot votes get one optional field:

| Field | Type | Meaning |
|---|---|---|
| `reason` | `string`, at most 300 characters | One plain sentence with no code references: why this decision and severity. |

Changes by file:

- **`packages/core/src/types.ts`.** `AiReviewFinding` gains `criteria?: string[]` and
  `fix?: string`.
- **`packages/core/src/aiReview.ts`.** `normalizeFinding` keeps `criteria`: uppercase it, dedupe,
  drop values that don't match, and keep `[]`. A non-array is omitted. It keeps `fix` when the
  trimmed value is non-empty and omits it otherwise.
- **`packages/core/src/reviewConsensus.ts`.**
  - `consensusFindingSchema` adds `criteria` and `fix` as optional.
  - `consensusVoteSchema` adds `reason` as optional and nullable.
  - Both schemas are `.strict()`, so without this change the new keys make the whole review fail to
    parse. Stored v2 comments have none of the new keys and keep parsing.
- **`packages/reviewer/src/consensus.ts`.** `newFindingSchema` adds both finding fields (nullable,
  optional) and normalizes them the way `normalizeFinding` does.
- **`packages/reviewer/src/review.ts`.**
  - **Implementation prompt.** When `parseAcceptanceCriteria` finds items, the section becomes
    `=== ACCEPTANCE CRITERIA (cite these ids in each finding's "criteria") ===`. It has one
    `AC<n>. <text>` line per item, then `Also required: <general>` when there is general text.
    Without items, the raw text is shown as it is today.
  - **Output contract.** Each finding is `{ severity, file, line, title, criteria, detail, fix }`:
    - `criteria`: the ids from the ACCEPTANCE CRITERIA section that the finding puts at risk, or
      `[]` when it is outside them or the prompt lists no ids;
    - `detail`: what is wrong and why it matters;
    - `fix`: the change that resolves it.
- **`packages/reviewer/src/consensusPrompt.ts`.** The vote shape adds
  `"reason":"one plain sentence: why this decision and severity"`. The `newFindings` shape adds
  `criteria` and `fix`.

The markers stay `ai-review/v1` and `ai-review/v2`. For the deploy order, see §8.

### 4.3 The worker's claim for each criterion

`submit_result` gains a field for the implementation stage only. The new field goes on the MCP tool
and on core's `submitResultSchema`, which the HTTP agent route also validates with.

```ts
criteria?: Array<{ id: string; claim: string }>   // claim: 1–600 characters
```

- **Doc stages.** `ops/submitResult.ts` `assertStageShape` rejects the field on doc stages, the way
  it rejects `verification`.
- **Validation.**
  - Every id must come from `parseAcceptanceCriteria(row.acceptance_criteria)`, and each id may
    appear once.
  - Otherwise the submit fails with a `ValidationError` that names the valid ids, for example
    "unknown criterion AC9; this task has AC1–AC8".
  - Leaving ids out is allowed; the UI shows "No claim" for them.
- **Storage.** The claims are written as one comment activity right after the `result` row, in the
  same transaction, the way the `verify:` comment is.
  - The body is `criteria-claims/v1` followed by a fenced JSON block:
    `{"claims":[{"id":"AC1","claim":"…"}]}`.
  - The marker helpers `isCriteriaClaimsMarker` and `parseCriteriaClaims` go in a new
    `packages/core/src/criteriaClaims.ts`.
- **Reading.** `criteriaClaimsFor(db, taskId)` in `repo/` returns the claims from the latest
  `criteria-claims/v1` comment whose id is greater than the latest `result` id, and null otherwise.
  It is a dedicated query, not a scan of the 50-row `activity` slice. It is exposed as
  `TaskDetail.criteriaClaims: Array<{ id: string; claim: string }> | null`.
- **Activity feed.** `ActivityItem` renders a claims comment as "Reported on N acceptance criteria"
  with the list in a `<details>`, not as raw JSON.
- **Protocol.** `PROTOCOL_VERSION` goes from 7 to 8.
  - `ProtocolInput` for the implementation stage gains
    `criteria: Array<{ id: string; name: string | null }>`, which `getNextTask.ts` fills from the
    parser.
  - When `criteria` is non-empty, the `submit_result` finish step adds: "and `criteria`: one
    `{ id, claim }` per acceptance criterion, a sentence on how the change meets it and which test
    proves it. Ids: AC1 Stale fence, AC2 Unfenced calls, …".
  - The `submit_result` tool description mentions the field.

### 4.4 Approving with a reason

- **`ops/approval.ts`.** `applyApproval` gains a last parameter, `overrideReason: string | null =
  null`. Inside the transaction it builds the brief (§5) from `aiReviewFor` and the row's
  `acceptance_criteria` and `stage`.
  - If the actor is human, the headline is `changes_needed` or `your_call`, and the reason is
    blank, it throws `ValidationError('approving over must-fix issues or open decisions needs a
    reason')`. `server/errors.ts` already maps that to HTTP 400.
  - The auto-approve path only runs on clean reviews, so it never reaches this check.
- **The override comment.** It is still written under today's condition (verdict `findings` or
  `disputed`).
  - Its body becomes `override: approved over <must> must-fix, <call> open decision(s) and <n>
    minor issue(s)`, listing only the non-zero parts, followed by `\n\nReason: <reason>` when a
    reason was given.
  - No code parses this body; `approval.ts` is its only writer.
- **The approve op and its callers.**
  - `reviewApprove` gains `overrideReason?: string` and passes it through.
  - `createCore` binds it as `reviewApprove: (key, actorUserId = null, overrideReason?: string)`.
  - `POST /api/tasks/:key/approve` accepts an optional body `{ reason?: string }`, validated by a
    new `approveBody` in `web/server/schemas.ts` (trimmed, 1–2000 characters).
  - The client call becomes `api.approve(key, reason?)`.
- **KPI.** `findingsAtApproval` and the override rate are unchanged. The rate only checks whether
  the count is above zero, and minor-only approvals still write the override comment (§6.8).

## 5. The review brief

New `packages/core/src/reviewBrief.ts`:

```ts
export function buildReviewBrief(review: AiReviewSummary | null, acceptanceCriteria: string,
  stage: Stage): ReviewBrief | null;
```

- The function is pure and returns null when there is no review.
- It is attached as `Task.reviewBrief` wherever `aiReview` is attached: `listRows` and `toDetail` in
  `repo/tasks.ts`.
- It's computed in core because the approve check (§4.4) needs the same rules, and the web client
  can import core's types but not its runtime.

Types (in `types.ts`):

```ts
export type ReviewHeadline = 'changes_needed' | 'your_call' | 'minor' | 'clean' | 'pending';
export type ReviewGroup = 'must' | 'call' | 'should' | 'fyi';
export type ReviewDispute = 'severity' | 'validity' | 'unverified';

export interface ReviewOpinion {
  reviewer: string;
  decision: 'confirm' | 'reject' | 'uncertain';
  severity: AiReviewSeverity | null;
  reason: string | null;
  evidence: string;
}
export interface ReviewIssue {
  id: string;                       // consensus candidate id; v1: F1…Fn by position
  group: ReviewGroup;
  dispute: ReviewDispute | null;    // set only when group is 'call'
  title: string;
  problem: string | null;           // finding.detail
  fix: string | null;
  file: string | null;
  line: number | null;
  criteria: string[] | null;        // null = unknown (legacy review, no id in the title)
  source: string | null;            // the reviewer who raised it
  opinions: ReviewOpinion[];        // [] for a single-reviewer (v1) review
  merged: Array<{ id: string; title: string; source: string; opinions: ReviewOpinion[] }>;
}
export interface ReviewCriterionRow {
  id: string;
  name: string | null;
  text: string;
  status: 'not_met' | 'your_call' | 'concerns' | 'clear';
  issueIds: string[];
}
export interface ReviewBrief {
  headline: ReviewHeadline;
  reviewers: string[];              // consensus participants, or [reviewer] for v1
  headSha: string | null;           // consensus.submission.headSha
  counts: { must: number; call: number; should: number; fyi: number; merged: number; rejected: number };
  issues: ReviewIssue[];            // must, call, should, fyi; candidate order within a group
  rejected: Array<{ id: string; title: string; source: string; opinions: ReviewOpinion[] }>;
  criteria: ReviewCriterionRow[];   // [] unless the stage is implementation and items parsed
  generalCriteria: string | null;
  unlinked: number;                 // open issues whose criteria is null
}
```

### 5.1 Issues from a consensus review (v2)

Walk the candidates in order:

1. **Rejected.** A candidate whose outcome is `rejected` goes to `rejected`.
2. **Duplicates.** When every vote names the same non-null `duplicateOf` T, resolve T to its root,
   following merges back to a candidate that wasn't merged itself.
   - If the root isn't rejected, the candidate goes into the root's `merged` list.
   - `duplicateOf` only points at earlier candidates, so one pass is enough.
   - A duplicate of a rejected candidate stays an issue of its own.
3. **Everything else is an issue**, grouped by its outcome and votes:

| Outcome and votes | group | dispute |
|---|---|---|
| confirmed, agreed severity `error` | must | — |
| confirmed, agreed severity `warning` | should | — |
| confirmed, agreed severity `info` | fyi | — |
| disputed, every vote `confirm` (severities differ, or one is null) | call | severity |
| disputed, every vote `uncertain` (a late `newFindings` candidate) | call | unverified |
| disputed, any other mix (confirm against reject, or with uncertain) | call | validity |

4. **Merged candidates can raise their root.** The group ranks must > call > should > fyi. The
   merged issue takes its group and dispute from whichever candidate ranks highest, the root or one
   of its merged candidates. On a tie the root wins.
5. **Criteria links.**
   - `criteria` is the union of the root's and the merged candidates' `finding.criteria`.
   - If none of them reports criteria, fall back to the legacy rule: take ids matched by
     `/\bAC\s?(\d+)\b/gi` in their titles, keeping ids that exist among the parsed items.
   - With no match, or no parsed items, `criteria` is null.
6. **Severity comes from the votes**, never from `finding.severity`. AF-146's F5 was raised as
   `info` and voted warning and error.

### 5.2 Issues from a single-reviewer review (v1)

- Each item becomes issue `F<n>`.
- Its group follows the severity: `error` → must, `warning` → should, `info` → fyi, and null →
  should.
- `opinions` is `[]` and `source` is the reviewer.
- There are no merges, rejections or disputes.

### 5.3 Headline

- **`pending`** when `review.verdict` is `pending`. The issues are still computed from the superseded
  review, and the UI shows them read-only.
- Otherwise:
  - **`changes_needed`** if any issue is must;
  - else **`your_call`** if any issue is call;
  - else **`minor`** if any issue is should or fyi;
  - else **`clean`**.

### 5.4 Criteria rows

- **When there are rows.** Only for the implementation stage, with at least one parsed item. The
  criteria are the deliverable in the description stage, so that stage has no rows.
- **Status**, from the linked issues:
  - any must → `not_met`;
  - else any call → `your_call`;
  - else any should or fyi → `concerns`;
  - else `clear`.
- **`issueIds`** follow issue order.
- **Unlinked issues.** An issue with `criteria: []` is outside the criteria. One with `criteria: null`
  is unlinked and counts toward `unlinked`.

### 5.5 Worked example: AF-146 round 3, also the test fixture

| Issue | Group | Merged | Criteria | Votes |
|---|---|---|---|---|
| F1 AC6 liveness not met: wall-clock kill ignores heartbeats | must | F7 | AC6 | error · error |
| F6 Reservation does not exclude another live execution | must | — | AC4 | error · error |
| F3 AC5(a) crash-before-spawn: no failure/v1 note and no dispatcher test | call · severity | F9 | AC5 | warning · error |
| F5 Submit retry stops being idempotent once the reviewer reserves | call · severity | — | AC3 | warning · error |
| F8 Anonymous claims bypass execution fencing | call · severity | — | AC2 | warning · error |
| F2 AC7 has no reviewer-level test | should | — | AC7 | warning · warning |
| F4 Pending-reservation fallback ignores the workspace filter | should | — | `[]` | warning · warning |

- **Headline and counts.** The headline is `changes_needed`. The counts are must 2, call 3, should
  2, fyi 0, merged 2 and rejected 0.
- **With reviewer-reported links:**
  - AC4 and AC6 are `not_met`;
  - AC2, AC3 and AC5 are `your_call`;
  - AC7 is `concerns`;
  - AC1 and AC8 are `clear`.
- **The stored (legacy) comment.** It has no `criteria` fields, so only F1 (AC6), F2 (AC7) and F3
  (AC5) link, through their titles.
  - `unlinked` is 4 (F4, F5, F6 and F8).
  - AC5 is `your_call`, AC6 is `not_met`, AC7 is `concerns`, and the rest are `clear`.

The fixture is the stored consensus of activity 2989. Trim it to the participants, candidates and
submission, with one short history entry per phase, then regenerate the payload so that
`parseConsensusReview` still accepts it.

## 6. UI

### 6.1 Board card chip

`AiReviewChip` takes the brief.

| Headline | Chip | Text beside it | Colour token |
|---|---|---|---|
| `changes_needed` | Changes needed | "2 must fix · 3 your call" (non-zero parts) | `--st-blocked` |
| `your_call` | Your call · 3 | — | `--st-progress` |
| `minor` | Minor issues · 2 | — | `--accent-2` |
| `clean` | No issues found | — | `--st-done` |
| `pending` | Review pending | — | `--ink-2` |

- **Tooltip.** The chip's tooltip is the verdict sentence from §6.3.
- **Criteria strip.** For implementation tasks with criteria rows, `TaskCard` adds a strip:
  - one 16×10 cell per criterion, coloured by status;
  - `role="img"` with an aria-label that lists every status;
  - the caption "N of M criteria not met" when N > 0.
- **pr-review cards** get the chip only.

### 6.2 Drawer layout during review

- **ReviewPanel.** For a code task in `in_review`, the first Overview column opens with the new
  `ReviewPanel`. It replaces `aiReviewRow` and `reviewActions`.
- **Column 1 order:** banners → ReviewPanel → spec → original → plan → journey → discussion.
- **Acceptance criteria block.** The raw block is hidden while the panel shows the criteria table,
  because each table row expands to the full text.
- **Result summary.** It moves to the top of column 2 as "Worker's summary", clamped to 6 lines with
  "Show all". Columns 2 and 3 are otherwise unchanged.
- **Other statuses** keep today's chip row.
- **pr-review tasks** keep today's `ReviewActions`.

### 6.3 Verdict card

- **Title**, by headline: "Changes needed", "Your call", "Minor issues only", "No issues found" or
  "Review pending".
- **One sentence**, built by the client's `reviewSentence(brief)`.
  - AF-146: "2 must-fix issues: AC4 Race and AC6 Liveness aren't met. 3 more need your decision:
    both reviewers agree they're real but not on how serious. 2 should-fix."
  - When any dispute is about validity: "…the reviewers disagree whether they're problems".
  - For `pending`: "The reviewer hasn't looked at the latest result yet. The issues below are from
    the previous review."
  - For `clean`: "Both reviewers found nothing to fix." For a single reviewer: "Codex found nothing
    to fix."
- **Group pills** with counts: Must fix, Your call, Should fix and FYI. Clicking a pill filters the
  issue list, and clicking it again clears the filter.
- **Meta line**, for example "2 duplicates merged · 0 rejected · commit 4699e45 · Claude + Codex".
  "rejected" opens the rejected list.
- **Actions** (§6.7 and §6.8).
  - "Request changes (N)" is primary for `changes_needed` and `your_call`.
  - Otherwise the stage-aware Approve is primary.
  - When call issues are still undecided, a hint below the actions says "3 issues need your
    decision".
- **Reviewer short names.** Use the part before `/`, capitalized: `claude/claude-fable-5-1` becomes
  Claude, and `codex/gpt-6-astra (medium)` becomes Codex. The full name goes in `title`. If two short
  names would collide, use the full names.

### 6.4 Criteria table

- **When it shows.** Only when `brief.criteria` is non-empty.
- **Layout.** It starts with the same strip as the card, then has these columns:
  - Status;
  - Criterion: the id and name, or the first 80 characters;
  - Worker says: the claim, or "No claim";
  - Reviewers found: the linked issues' ids and titles, or "Nothing flagged".
- **Row click.** Clicking a row expands the full criterion text and the claim, and filters the issue
  list to that criterion.
- **General criteria.** `generalCriteria` is shown below the table as "Also required: …".
- **Unlinked issues.** When `unlinked > 0`, a line says "4 issues aren't linked to a criterion (this
  review predates criterion links)". Rows with no linked issues then say "No linked issues" instead
  of "Nothing flagged".
- **Status labels:** Not met, Your call, Concerns, Nothing flagged.
  - "Concerns" replaces the mockup's "Untested", because the brief can't tell a missing test apart
    from any other should-fix issue.

### 6.5 Issue cards

Cards sit under the headings Must fix, Your call, Should fix and FYI; empty groups are hidden. Each
card has:

- **Header:** a group badge, the title and the id.
- **Chips:**
  - the criteria (`AC6 · Liveness`), "Outside the criteria" for `[]`, or nothing for null;
  - `file:line`, which opens the evidence panel.
- **Problem and fix.** "Problem:" with the problem and "Fix:" with the fix, leaving out whichever is
  missing.
- **Merged note**, for example "Also raised as F7 (Codex)".
- **Agreement**, depending on the issue:
  - confirmed by 2+ reviewers: "Claude and Codex agree: must fix";
  - a severity or validity dispute: the opinions side by side, each with a verdict such as "Claude
    rates it Should fix" or "Codex: not a problem". Below the verdict goes the `reason`. Without a
    reason, show the first 240 characters of the evidence and an "Evidence" link.
  - unverified: "Raised late by Codex; no reviewer has verified it yet.";
  - v1: "Reported by <reviewer>".
- **Decision control.** A radio group: Must fix, Should fix, Dismiss.
  - Must issues default to Must fix and should issues to Should fix.
  - Call and fyi issues start undecided, and undecided issues aren't sent.
  - The control is disabled while the headline is `pending`.

Severity labels are error "Must fix", warning "Should fix" and info "FYI". Decision labels are
reject "Not a problem" and uncertain "Unsure". Decisions live in the panel's state, keyed by the
review signature, and reset when a new review lands, as in `ReviewActions` today.

### 6.6 Evidence panel

The panel opens from a `file:line` chip or an "Evidence" link, as a right-hand panel inside the
drawer. Below 900px it takes the full width. Esc or the close button returns focus to whatever
opened it.

It has six sections:

1. **Header:** the id, group badge and title.
2. **Criterion:** each linked criterion's id, name and full text.
3. **Worker says:** the claim for each linked criterion, or "No claim recorded".
4. **Code**, from the task's existing diff (`api.getDiff` and `parseUnifiedDiff`), fetched once per
   drawer open and keyed by `updatedAt`.
   - Find the file by exact path, or else by a unique suffix match.
   - Show the hunks that contain `line` (new-side numbers), with that line highlighted.
   - If no hunk contains the line, say "Line 253 isn't among the changed lines" and link to the
     Changes tab.
   - If the file isn't in the diff, say "This file isn't changed on the branch."
   - Show "reviewed at 4699e45" when `headSha` is known. The branch doesn't move while the task is in
     review, so the current diff is the one that was reviewed.
5. **Opinions:** each reviewer's decision, severity, reason and full evidence
   (`white-space: pre-wrap`).
6. **Merged duplicates:** each with its source and opinions, collapsed.

### 6.7 Sending changes back

"Request changes (N)" opens a dialog. N counts the issues decided as Must fix or Should fix.

- **Must fix and Should fix lists.** Each entry shows the id, title, criteria, location and fix.
- **Not sent.** Dismissed and undecided issues, each labelled with why.
- **Note.** An optional textarea.
- **Send button.** It reads "Send back N issues", or "Send note" when N = 0.
  - It is disabled when N = 0 and the note is blank.
  - It posts through the existing `request-changes` endpoint.

The client's `composeReviewFeedback` builds the body. It replaces `composeFeedback` for code tasks;
pr-review keeps `composePrReview`.

```
Changes requested after the AI review of 4699e45 (Claude + Codex), curated by a human.

## Must fix

1. F1 · AC6 · AC6 liveness not met: wall-clock kill ignores heartbeats (packages/dispatcher/src/dispatcher.ts:253)
   Problem: …
   Fix: …

## Should fix

1. F2 · AC7 · AC7 has no reviewer-level test (packages/reviewer/src/reviewer.ts:822)
   Problem: …
   Fix: …

## Note from the human reviewer

…
```

- **Missing parts.** Sections with no entries are left out, and so is a missing location, criterion,
  problem or fix.
- **Unknown commit.** Without a `headSha`, the first line reads "…after the AI review (…)".
- **No review.** The body is the note alone, as it is today.

### 6.8 Approving

- **`clean` and `pending`:** one click, as today.
- **`minor`:** one click and no reason. The override comment is still written (§4.4), so the KPI
  doesn't move.
- **`changes_needed` and `your_call`:** "Approve anyway…" opens a dialog with:
  - "Criteria not met: AC4 Race, AC6 Liveness", listing the `not_met` rows (left out when there are
    none);
  - "Still open: 2 must fix · 3 your call · 2 should fix";
  - a required reason field, "Why is it OK to ship this?";
  - the confirm button. It reads "Approve anyway → deliver", or "Approve anyway → implementation" for
    a doc stage, and is disabled until the reason has text. A 400 from the server shows inline.

The two-click "armed" state goes away.

### 6.9 Raw discussion

`ConsensusDiscussion` keeps only the raw part, retitled "Raw reviewer discussion · N messages" (the
history entries and candidates). It sits collapsed at the bottom of the panel. The "Needs human
decision" section is removed; the Your call group replaces it.

### 6.10 Other cases

- **Doc-stage review** (description, or legacy plan): there's no criteria table, and the approve
  label reads "Approve → implementation". Everything else is the same.
- **Single reviewer (v1):** no Your call group, no side-by-side opinions, and "Reported by codex".
- **No review yet:** the panel says "No AI review yet" and offers a plain Approve and a note-only
  Request changes.
- **Malformed review comment:** treated as no review (today's rule).
- **Accessibility:**
  - Status is never shown by colour alone; every chip and cell has a text label or aria-label.
  - Decision controls are radio groups.
  - Dialogs use `role="dialog"` and `aria-modal`, Esc closes them, and focus returns to the trigger.
  - At phone width, the table rows stack.

## 7. Keeping findings from the agent

Uncurated findings must not reach the implementing agent. `Task.reviewBrief` carries every finding,
so it is nulled together with `aiReview`:

- in `detailContent`;
- in the shared `withoutFailureTriage` sanitizer that `list_tasks` and `submit_result` use. This also
  closes an existing gap: `list_tasks` returns `aiReview` without stripping it.

`criteriaClaims` is the agent's own data and stays.

## 8. Compatibility and rollout

- **No migration.** `getVersion` is unchanged, because all new data rides on comment activity, which
  it already covers.
- **Stored reviews.** v1 and v2 comments without the new fields parse as before and get the legacy
  criteria fallback (§5.1).
- **Old workers.** Workers on protocol 7, including `/work-task` sessions started before the deploy,
  leave out `criteria`. The table shows "No claim".
- **Deploy order.** The v2 schemas are strict. A new reviewer that posts `criteria`, `fix` or
  `reason` to an old board would have its review degrade to a plain comment.
  - Rebuild, then restart :8787 and MCP sessions before or together with the reviewer.
  - In board mode, restart the board first.
  - Restarting the dispatcher puts new claims on protocol 8.
- **KPI.** `findingsAtApproval` and the override rate don't change. Only the override comment's
  wording does.

## 9. Implementation slices

Each slice ships on its own, without a flag, test first (RED, then GREEN).

1. **Core read model.**
   - Files:
     - add `acceptanceCriteria.ts`, `reviewBrief.ts` and the new types;
     - attach `Task.reviewBrief` in `repo/tasks.ts`;
     - export from `index.ts`;
     - null the brief in MCP payloads (§7).
   - Tests:
     - `core/test/acceptanceCriteria.test.ts`;
     - `core/test/reviewBrief.test.ts`, with the AF-146 fixture and synthetic dispute and duplicate
       cases;
     - MCP payload tests.
2. **Approve reason.**
   - Files: `ops/approval.ts`, `ops/reviewApprove.ts`, the `createCore` binding,
     `web/server/schemas.ts` (`approveBody`), `routes/tasks.ts`, client `api.ts`.
   - Tests: extend `core/test/reviewApprove.test.ts`, plus a server route test.
3. **Review panel.**
   - Files:
     - change `AiReviewChip.tsx`, `TaskCard.tsx`, `ConsensusDiscussion.tsx`, `DetailPanel.tsx` and
       `index.css` (`af-rv-*` classes);
     - add `ReviewPanel.tsx`, `ReviewCriteria.tsx`, `ReviewIssueCard.tsx`, `ReviewEvidence.tsx`,
       `ReviewSendBack.tsx`, `ReviewApprove.tsx`, `composeReviewFeedback.ts` and `reviewText.ts`
       (headline, sentence and short names);
     - keep `ReviewActions` for pr-review only.
   - Tests in `packages/web/test/client/`:
     - move the code-task cases out of `ReviewActions.test.tsx` and `consensusReview.test.tsx`;
     - keep `reviewActionsPrReview.test.tsx` as it is.
4. **Reviewer output.**
   - Files: the schemas and `normalizeFinding` (§4.2), and the prompts.
   - Tests: `reviewer/test/review.test.ts`, `consensusPrompt.test.ts`, `consensus.test.ts`,
     `core/test/aiReview.test.ts`, `core/test/consensusReview.test.ts`.
5. **Worker claims.**
   - Files:
     - core: `submitResultSchema`, `ops/submitResult.ts`, `criteriaClaims.ts`, `criteriaClaimsFor`,
       `TaskDetail.criteriaClaims`;
     - MCP: `submit_result`, `protocol.ts` (v8 plus the description-stage wording),
       `getNextTask.ts`;
     - client: `ActivityItem`.
   - Tests: core submit tests, `mcp` protocol tests and the tool test.

After slices 1–3 the panel already works on today's data: AF-146 renders with correct groups and the
legacy criteria fallback. Slices 4 and 5 add criterion links, fixes, reasons and claims.

For each slice:

- run the focused tests, then `npm test`, `npm run build` and
  `npm -w packages/web run typecheck:client`;
- slice 3 also needs a look in the running app at an in-review task with a v2 review.

## 10. Acceptance criteria

1. Criteria parsing — `parseAcceptanceCriteria` returns AC1–AC8 for AF-146's text, with the names
   "Stale fence" through "Version gate", and puts the closing "Each item is covered…" paragraph in
   `general`. Nested bullets and continuation lines stay with their item. Non-list text becomes a
   single AC1, and empty text gives no items.
2. Issue grouping — for AF-146's stored review, `buildReviewBrief` returns the 7 issues, groups,
   merges and counts in §5.5, with headline `changes_needed`.
3. Dispute kinds — synthetic consensus fixtures produce:
   - dispute `validity` for confirm against reject;
   - dispute `unverified` when every vote is uncertain;
   - an issue of its own for a duplicate whose root was rejected;
   - a raised group for a root at should with a merged must.
4. Criterion status — the AF-146 criteria rows match §5.5 both with reviewer-reported links and with
   the legacy title fallback. `unlinked` is 4 for the legacy comment.
5. Reviewer contract:
   - The implementation prompt lists `AC<n>.` ids.
   - A v1 finding carrying `criteria` and `fix`, and a ballot vote carrying `reason`, keep those
     values through parsing, consensus, the posted `ai-review/v2` comment and
     `parseAiReviewComment`.
   - The existing stored-review fixtures still parse unchanged.
6. Worker claims:
   - An implementation `submit_result` with `criteria` stores one `criteria-claims/v1` comment.
   - Unknown ids, duplicate ids and doc-stage use are rejected with a `ValidationError` that names
     the valid ids.
   - `criteriaClaims` is null once a newer result exists without claims.
   - Protocol 8 lists the task's ids in the finish step.
7. Board chip — the card chip shows the label, text and token from §6.1 for each headline. The
   criteria strip and its caption appear only for implementation tasks with parsed criteria.
8. Review panel — an in-review code task shows the verdict card, the criteria table and the issue
   groups in order:
   - Must and should issues are preselected; call and fyi issues start undecided.
   - The hint counts only undecided call issues.
   - A pending review shows its issues read-only.
9. Evidence — clicking `file:line` opens the panel with:
   - the linked criteria and the worker's claim;
   - the diff hunk with the line highlighted, or the "isn't among the changed lines" or "isn't
     changed" message;
   - every opinion, and the merged duplicates.
10. Send back:
    - The composed body contains exactly the issues decided as Must fix or Should fix, each with its
      problem, fix, location and criteria, plus the note.
    - Undecided and dismissed issues are missing from the body and listed as not sent in the dialog.
    - The send button is disabled when nothing would be sent.
11. Approve with a reason:
    - With a must-fix issue or an open decision, approving without a non-blank reason fails with
      HTTP 400 and leaves the task in review.
    - With a reason, the task approves and the override comment records the reason.
    - Minor-only reviews approve in one click and still write the override comment.
    - Clean and pending reviews behave as today.
    - `findingsAtApproval` returns the same values for existing histories.
12. Agent isolation — the payloads of `get_next_task`, `get_task`, `list_tasks` and `submit_result`
    carry `reviewBrief: null` and `aiReview: null`.
13. Unchanged paths:
    - pr-review tasks render today's `ReviewActions`.
    - `npm test`, `npm run build` and `npm -w packages/web run typecheck:client` pass.

## 11. Decisions

- **The brief is built in core, not the client.** The approve rule needs the same derivation, and
  the client can't import core's runtime. The card and the drawer then read the same object.
- **Ids are positional.** One parser serves the prompt, the protocol and the UI, so a criterion's id
  can't drift between them. Criteria already numbered 1…n in order keep their numbers.
- **"Concerns" instead of "Untested".** "Untested" would need reviewers to classify a finding as a
  test gap or a defect, and that extra field isn't worth it.
- **A reason only when it matters.** Changes-needed and your-call approvals need one. Minor-only
  approvals stay one click, so warnings don't train people to type filler.
- **Claims are a marker comment, not a column.** This follows the `verify:` and `ai-review/v1`
  precedent, keeps the data derived, and needs no migration.
- **Undecided issues aren't sent.** The human picks what the agent gets. The dialog lists everything
  left out, so nothing is dropped silently.
