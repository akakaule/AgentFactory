# Agent model settings: implementation plan

Spec: `docs/spec/2026-10-23-agent-model-settings-design.md`. Branch `feat/agent-model-settings`, with PR #67
(Claude reviewer `--effort`) folded in as its first commit.

## Decisions the spec leaves open

- **Pure resolvers.** `resolveAgentModel(models, role, workspace, fileDefault?)` and
  `resolveReviewers(models, workspace, fileReviewers?)` take the document as an argument. Supervisors already
  read it once per tick (`getAgentModels`), so resolving needs no further board call. With no `fileDefault`
  the result is the board layer alone (or `null`), which is how the dispatcher knows to drop `stageArgs`.
- **Plan fallback is per layer:** workspace `plan ?? description`, then global `plan ?? description`.
- **Reads drop deleted workspaces; writes reject unknown ones.** `getAgentModels` filters the overrides to
  existing workspaces, so a modal never sends a stale key back, and `setAgentModels` answers 400 for a key
  that names no workspace (AC6). Empty objects (`{}` layers, an empty `stages`) are stripped on save.
- **Slice methods are optional** (`getAgentModels?`, `reportAgentModelDefaults?`) on `DispatcherCore` /
  `ReviewerCore`, like `reserveExecution?`. The existing supervisor fakes then compile and behave unchanged
  (AC3).
- **Defaults report.** It is sent on the first tick that succeeds rather than only at process start, so a
  board that is down at startup still gets it. The config never reloads at runtime today, so the report goes
  once per process. `at` is set by the board. The store keeps at most 50 supervisors (oldest dropped).
  `extraArgs` holds the **stage** args that are not model or effort, because those are the args a board
  setting drops. The global args still apply either way.
- **Arg parsing and flag building live in core** (`profileFromArgs`, `modelProfileArgs`), so the dispatcher
  report and the dispatcher spawn share one tested implementation. The reviewer keeps `buildEngineArgs`, which
  already emits the same flags.
- **Consensus.** `effective = board.global.consensus ?? config.consensus?.enabled ?? false`. Timing comes
  from `config.consensus` or the schema defaults (30 min, 500,000 chars). This fixes the
  `config.consensus!.maxPromptChars` dereference, which would crash when the board enables consensus and
  the file has no block.
- **The workspace section saves with the workspace's own Save button.** When the section changed, it
  PUTs the full document with only that workspace's entry replaced. `WorkspacesModal` loads the document
  once and passes it down.

## Steps (TDD, one commit each)

1. **core:** `src/agentModels.ts` holds the types, zod schemas, `MODEL_CATALOG`, normalize/get/set,
   `resolveAgentModel`, `resolveReviewers`, `profileFromArgs`, `modelProfileArgs`, and the defaults report
   (get/report). Also: `createCore` bindings, index exports, `HttpCore.getAgentModels` +
   `reportAgentModelDefaults`, and `test/agentModels.test.ts`.
2. **web server:** `routes/agentModels.ts` (GET/PUT `/api/agent-models`). On agent ops, add
   `GET /agent-models` and `POST /agent-models/defaults`. Mount the route, then add route tests and HttpCore
   contract cases.
3. **dispatcher:** read the document per tick, and change `engineFor(stage, workspace)` to return the board
   profile. Spawn appends the profile flags in place of `stageArgs`. Send the defaults report. Tests cover
   AC1, AC2, AC5 and AC8 with the existing fake spawn.
4. **reviewer:** read the document per tick. Add `reviewersFor(workspace)`, per-workspace
   `activeReviewers`, board consensus, and visualization/feedback-eval profiles with effort. Send the
   defaults report. Tests cover AC4 and AC5.
5. **client:** the Agents modal gets Models and System prompts tabs, with an `AgentModelsPanel` (cards,
   reviewer list, other agents, source chips, warnings, footer). The Workspaces modal gets a
   `WorkspaceAgentModels` section. Add client tests and update the existing modal mocks.
6. **Docs:** dispatcher/reviewer README notes and the CLAUDE.md architecture line.
