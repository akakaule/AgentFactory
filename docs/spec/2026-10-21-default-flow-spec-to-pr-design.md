# Default flow: intent → spec → review → implement → review → PR → merged

**Date:** 2026-10-21
**Status:** Approved
**Supersedes, in part:** [multi-stage pipeline](../superpowers/specs/2026-06-12-multi-stage-pipeline-design.md)
(the plan stage and the API's implementation-only default) and the worker-side auto-open GitHub
PR step (protocol v6).

## Problem

The desired default flow is:

> intent / description → spec → review spec → implement → review implementation → create PR → PR completed

Today's flow differs in two places.

1. **An extra plan stage.** New tasks walk `description → plan → implementation`. Both doc stages
   are AI-reviewed and auto-advance on a clean verdict, so the plan stage adds a second AI-reviewed
   document but no human gate.
2. **The PR opens before review, GitHub only.** The implementation worker runs `gh pr create`
   before `submit_result`. Azure DevOps origins never get a PR automatically; the board only shows a
   manual "Open PR" deep link once the task is delivering.

## Design

### Stages: spec → implement

- The pipeline becomes `description → implementation`. The description stage already writes the
  task's `spec` and `acceptanceCriteria`; the board labels it **Spec**. The stored value stays
  `description` (no migration, no history rewrite).
- A `NEXT_STAGE` map in core replaces `STAGE_ORDER[indexOf + 1]` in the approval op:
  `description → implementation`, `plan → implementation`.
- `plan` remains a **legacy** stage value: it stays in the `Stage` type, DB CHECK, zod enums, the
  MCP stage check, the dispatcher's `stageEngines`/`stageArgs` (strict schema, so existing config
  files keep parsing), the reviewer's plan prompt, and the trail parser. An in-flight plan task
  finishes its plan and advances to implementation. New tasks are never routed there by the flow.
- The auto-approve policy is unchanged: a clean AI review advances a doc stage; implementation is
  always approved by a human.

### Default entry: the full flow

- The REST create route and the MCP `create_task` tool default `stage` to `description` for code
  tasks when the caller sends none. `pr-review` tasks keep entering at `implementation` (their
  only stage). Core's `createTask` default stays `implementation`, so direct core callers and the
  large body of core test fixtures are unaffected.
- This reverses the 2026-06-12 decision that API callers opt into the pipeline. Callers that pass
  a stage explicitly (ado-bridge, clawpatch bridge) are unaffected; the PR-review bridges send no
  stage but create `pr-review` tasks, which stay at implementation.

### PR creation moves to the watcher, after approval

- **Push before review stays** (settled 2026-06-12). Only PR creation moves.
- The implementation worker protocol drops the `gh pr create` step and the PR link from
  `submit_result`. `PROTOCOL_VERSION` 6 → 7.
- When a task is `delivering` and the watcher's provider check finds no PR for the branch, the
  watcher **opens one** through the host REST API against the repository's default branch:
  - GitHub: `GET /repos/{o}/{r}` (`default_branch`), then `POST /repos/{o}/{r}/pulls`.
  - Azure DevOps: `GET …/git/repositories/{repo}` (`defaultBranch`), then
    `POST …/pullrequests`.
  - Title `<KEY>: <task title>`; body = the worker's result summary plus a footer naming the task.
  - The created PR is recorded with the existing `recordDeliveryCheck` (works in DB and board mode,
    fenced by `expected`), as `prState: 'open'`, checks `pending`.
  - "Already exists" (GitHub 422, ADO 409) is not an error: the watcher records `not_found` and the
    next tick's search picks the existing PR up.
  - Any other failure is logged once per task and recorded as `not_found`; the board's existing
    "Open PR" deep link stays the manual fallback.
  - `createPullRequests` (watcher config, default `true`) turns this off.

### Delivery episodes

A delivery episode starts at approval. `upsertDelivery` seeds the episode's `prUrl` from the newest
`pr` link, which is null once workers stop submitting PR links.

- **Search order** (both providers): merged, then open, then newest. GitHub previously took the
  most recently updated PR, which could be a closed one even while an open PR existed.
- **Unattributed closed PR** (found by search while the episode has no `prUrl`): it belongs to an
  earlier episode. It is never recorded as closed and never bounces; the watcher opens a fresh PR.
  This also fixes the ADO gap where a re-approved task re-found its abandoned PR and bounced
  immediately.
- **Attributed closed PR** (the PR this episode opened or was given): bounces `pr_closed` as today.
  The bounce note now says a fresh PR opens from the same branch after re-approval.
- **CI-failure repair**: the PR stays open; the repair worker pushes to the same branch; after
  re-approval the search finds the open PR and reuses it.
- **Legacy tasks** whose worker opened the PR carry a `pr` link, so the watcher finds that PR and
  creates nothing. `reconcileMergedDelivery`'s pr-link consistency check is unaffected.

### Credentials

Creating PRs needs write scope. GitHub tokens (watcher `GITHUB_TOKEN` or the workspace PAT) need
**Pull requests: Read and write**; Azure DevOps PATs need **Code (Read & write)**. A 401/403 on
create is reported as a missing write scope.

## Non-goals

- Removing `plan` from the schema, enums, or dispatcher config.
- A per-task choice of flow beyond the existing "Implementation only" option.
- Changing ado-bridge.
- Draft PRs, reviewers, labels, or PR templates.
