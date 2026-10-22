# Default flow spec → PR: implementation plan

Design: [docs/spec/2026-10-21-default-flow-spec-to-pr-design.md](../spec/2026-10-21-default-flow-spec-to-pr-design.md)
Branch: `feat/default-flow-spec-to-pr`. Test-first for each step (RED, then GREEN).

## 1. Core: next stage

- `packages/core/src/types.ts`: add `NEXT_STAGE` (`description → implementation`,
  `plan → implementation`). Keep `STAGE_ORDER` for metrics ordering.
- `packages/core/src/ops/approval.ts`: use `NEXT_STAGE`.
- Tests: `core/test/reviewApprove.test.ts`, `addComment.autoApprove.test.ts`, and any
  test asserting `description → plan` → now `description → implementation`; add a legacy
  `plan → implementation` case.

## 2. API default entry

- `packages/web/server/routes/tasks.ts` create route: `stage ?? (kind === 'pr-review' ? undefined : 'description')`.
- `packages/mcp/src/tools/createTask.ts`: default `stage` to `description`; update description text.
- Tests: `web/test/server/tasks.test.ts` (no-stage create → description; pr-review → implementation);
  `mcp/test/tools.test.ts` (no stage, no AC → accepted at description).
- Fix web tests that POST without a stage and expect an implementation task: pass
  `stage: 'implementation'` explicitly.

## 3. Labels and agent text

- Client: `status.ts` (`Spec`), `TaskForm.tsx`, `ReviewActions.tsx`, `DetailPanel.tsx` tooltip,
  `TaskMetrics.tsx`; update label assertions in client tests.
- `protocol.ts` description-stage wording; `intake.ts` remedy text;
  `.claude/commands/{work-task,review-task,visualize-task}.md`.

## 4. Worker protocol v7

- `packages/mcp/src/protocol.ts`: remove the PR step and PR-link submit text; `PROTOCOL_VERSION = 7`.
- `packages/mcp/src/tools/getNextTask.ts`: drop the GitHub detection input.
- Tests: `protocol.test.ts` (no `gh pr` for any origin), version assertions.

## 5. Watcher creates the PR

- `watcher/src/types.ts` + `http.ts`: `FetchJson` init with optional `method`/`body`; JSON send.
- `providers/types.ts`: `openPullRequest(remote, { branch, title, body })`.
- `providers/github.ts` and `providers/azdo.ts`: default-branch lookup, POST, 201 accepted,
  422/409 → null, write-scope auth message; search order merged → open → newest.
- `watcher.ts`: create when delivering and (no PR, or unattributed closed PR); record via
  `recordDeliveryCheck`; warn once on failure; `pr_closed` bounce text.
- `config.ts`: `createPullRequests` (default true); scope docs.
- Tests: `watcher/test/*` (GitHub + ADO create, 422/409, not delivering, flag off, unattributed vs
  attributed closed, search order).

## 6. Docs

- Root `CLAUDE.md` lifecycle paragraph; README pipeline mentions; watcher/mcp README scope notes.

## 7. Verify

- `npm run build && npm test && npm -w packages/web run typecheck:client`.
- E2E on a scratch DB: REST create (no stage) → description; drive to delivering; one watcher tick
  with `GITHUB_TOKEN` against a throwaway branch on `akakaule/AgentFactory`; confirm the PR is
  created and recorded; close it and delete the branch.
