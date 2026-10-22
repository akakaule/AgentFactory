# Azure DevOps work-item import, configured per workspace (ado-bridge → AgentFactory)

Status: approved 2026-10-22. Visual overview: https://claude.ai/artifact/Bjsx9xbHCJ1AATaBtxHPX6 (private).

## Context

Today the Azure DevOps backlog bridge lives in a separate PowerShell repo (`c:\git\ado-bridge`, `Run-AdoBridgeLoop.ps1`). Each repo has its own `ado-bridge.config.json` and runs its own loop. That loop does four things:

- It claims matching work items: assigns them, sets them to Active, and tags them `agentfactory` and `AF:<key>`.
- It creates queued `AB#<id>: <title>` board tasks at the spec stage.
- It reflects the implementation review back to ADO as Resolved.
- It closes the work item, with the result summary, once the task is done.

The goal is to build this into AgentFactory, so that **an Azure DevOps workspace's own settings decide which work items get imported**.

Decisions (2026-10-22):

- **Scope:** the work-item import only, plus its write-back. The PR-review loops, clawpatch and add-task stay in ado-bridge for now.
- **Runtime:** a pass inside the **watcher**, so there is no new process. The watcher already has ADO REST access, the workspace PAT with env fallbacks, origin detection, the served-workspace set, backoff, and a place in `npm run supervisors`.
- **Write-back:** full, the same as ado-bridge today.

Intended outcome: in the board's Workspaces modal, an ADO workspace gets an "Azure DevOps work items" section. The user enables it, set the filters (types, states, area path, iteration path, tag) and the state mapping, and save. From the next watcher tick on, matching items appear on the board, queued at the spec stage. The organization and project come from the workspace's origin, so they are never re-entered.

## Design

### 1. Settings in core: a new `packages/core/src/adoSync.ts`

- **`AdoSyncSettings` and a zod schema.** Defaults match ado-bridge (Agile process).

  | Field | Default | Meaning |
  |---|---|---|
  | `enabled` | false | Turns the import on for this workspace. |
  | `workItemTypes` | `["User Story"]` | Work item types to import. An array, used with `IN (…)`. |
  | `states` | `["New"]` | Work-item states that count as new. |
  | `areaPath`, `iterationPath` | `""` | `UNDER` filters. A `/` is accepted and converted to `\`. |
  | `requiredTag` | `""` | Opt-in tag. Must differ from `markerTag`. |
  | `orderBy` | `""` | Empty means StackRank, then ChangedDate. |
  | `assignTo` | `""` | Empty means the PAT owner, looked up via `_apis/connectionData`. |
  | `claimState` | `Active` | State set when an item is claimed. |
  | `reviewState` | `Resolved` | Set when the implementation goes to review. `""` turns it off. |
  | `closeState` | `Closed` | Set when the task is done. |
  | `markerTag` | `agentfactory` | Tag that marks an item as imported. |
  | `stage` | `description` | Stage new tasks start at: `description` or `implementation`. |
  | `autoQueue` | true | Queue imported tasks straight away. |
  | `maxDescriptionChars` | 8000 | Cap on the imported description. |
  | `maxImportsPerTick` | 10 | Cap on imports per watcher tick. |

- **`buildInboundWiql(settings, assignee)`.** A pure port of `Build-InboundWiql`: the opt-in tag clause, the recovery clause, `''` escaping, and backlog order. It lives in core so that both the watcher and the board server can use it. The web client imports only *types* from core (its runtime pulls in `node:sqlite`), so the server computes the preview: `GET /api/workspaces` returns `adoSyncWiql` for the saved settings, and the UI shows it read-only. An empty `assignTo` previews as the `@Me` macro.
- **`htmlToText(html, maxChars)`.** A pure port of `Convert-HtmlToText`.
- **`AB_PREFIX = /^AB#(\d+):/`.** The dedup key. It matches the tasks the PowerShell bridge already imported, so switching over never re-imports anything.

### 2. Storage

- **Migration #27.** Add a `workspace.ado_sync TEXT` column holding the JSON settings. The add is guarded by a `PRAGMA table_info` check, following the #19, #20 and #23 pattern. Bump the `user_version` 26 → 27 assertions in `migrate.test.ts`, `claim.test.ts` and `attachments.test.ts`.
- **Shared types.** Core's `Workspace` type gains `adoSync: AdoSyncSettings | null`, and `UpdateWorkspaceInput` gains `adoSync?`.
- **Reading and writing.** `repo/workspaces.ts` parses the column when it reads a workspace and writes it in `updateWorkspaceFields`. A corrupt value reads as null, which means off.
- **Validation.** Add the field to `validate.ts` `updateWorkspaceSchema` and its refine. Add the same field to the web route's duplicate list in `web/server/schemas.ts` `workspaceUpdateBody`.
- **What the board sees.**
  - `GET /api/workspaces` adds `remote: { provider, organization?, project? } | null` to each workspace. The route works it out server-side with `resolveOriginUrl` and `parseRemoteUrl`, cached by `repoPath`.
  - `PATCH` returns 400 when `adoSync.enabled` is true but the origin isn't Azure DevOps.

### 3. Importing tasks: a new core op `importTask`

**The problem.** Moving a task from backlog to queued is human-only, and a service-token supervisor counts as an agent. So in board mode the watcher cannot queue a task today.

**The fix.** Add an `importTask(input & { queue })` op. In one transaction it:

0. returns the existing task (`created: false`) when the workspace already has a task whose title starts with the given `dedupPrefix` (`AB#123:`). This makes the op idempotent over HTTP retries and closes the race between two ticks;
1. creates the task with `actor: 'human'` and `actorUserId: null`, because the human configured the import. `createTask`'s body is split into a `createTaskWithinTransaction` helper, since core transactions don't nest;
2. appends an `ado-import/v1 — imported AB#123 from Azure DevOps` comment, so the activity log shows where the task came from;
3. queues the task with `updateStatusWithinTransaction`, when `queue` is set.

**Wiring.**

- Bind the op in `createCore`.
- Add it to `HttpCore` (`core/src/httpCore.ts`).
- Expose it as a `requireSupervisor` route `POST /api/agent/import-task` in `web/server/routes/agentOps.ts`.
- Add it to `WatcherCore`.
- Extend the contract test and `agentOps.test.ts`.

### 4. The watcher's ADO sync pass

**ADO REST client: a new `packages/watcher/src/providers/azdoWorkItems.ts`.** It reuses the azdo `guard` (move it to a shared helper), `basicPat` and `FetchJson`.

| Function | ADO call |
|---|---|
| `wiql` | `POST {org}/{project}/_apis/wit/wiql` |
| `workItemsBatch` | `POST …/wit/workitemsbatch`, in chunks of 200, with `errorPolicy: omit` |
| `patchWorkItem` | `PATCH …/wit/workitems/{id}`, sent as `application/json-patch+json`, with an optional `test /rev` op |
| `whoAmI` | `GET {org}/_apis/connectionData` |

**HTTP changes.**

- The `FetchJson` method type gains `'PATCH'` (`watcher/src/types.ts`).
- `http.ts` keeps a caller-supplied content-type instead of overwriting it with JSON.

**The sync pass: a new `packages/watcher/src/adoSync.ts`.** On each tick, for each served workspace whose `adoSync.enabled` is true:

1. **Resolve the remote and credentials.**
   - Resolve the remote with `remoteFor(repoFor(ws))`. When it isn't ADO, warn once and skip.
   - Resolve the credential with the existing `resolveCredential(env, 'AZDO_PAT', ws, await core.getWorkspacePat(ws))`.
2. **Inbound** (a port of `Invoke-InboundPass`):
   - Run the WIQL, then fetch the matching items in a batch.
   - Build the dedup index from `listTasks({ workspace })` using the `AB#` prefix.
   - Claim each new item with a rev-tested PATCH that sets AssignedTo and `claimState`. A lost race is skipped. An item already claimed by the assignee is resumed.
   - Call `importTask` with:
     - title `AB#<id>: <title>`
     - spec `ADO Work Item: AB#<id> - <url>\n\n<description as text>`
     - a `url` link labelled `AB#<id>`
     - the configured `stage`, with `queue` set from `autoQueue`
   - Re-queue any matched task that is still in backlog when `autoQueue` is on.
   - Write the commit marker: a rev-tested PATCH that adds the tags (`markerTag` and `AF:<key>`) and a history entry.
   - Stop after `maxImportsPerTick` imports.
3. **Outbound** (a port of `Invoke-OutboundPass`):
   - **Implementation in review → `reviewState`.** Applies only when the item is still in `claimState`.
   - **Done → `closeState`.** Applies when the item is in `claimState` or `reviewState`. It posts the HTML-encoded result summary as a history comment.
   - The pass skips items already in the target state, and items someone moved by hand. That keeps it idempotent.
4. **Error handling.**
   - A failure on one item logs and retries on the next tick, so the other items still sync.
   - On a 429, the shared `pausedUntil` is set.
   - On an auth error (203/401/403), the watcher warns once and names the missing scope, **Work Items (Read & write)**.
   - On other errors, the workspace backs off using the existing per-key backoff map, keyed `ado-sync:<ws>`.
   - `noteFailure` gets a `'work-item sync'` label.

**Dropped on purpose:** ado-bridge's `prCompletedState` pass. In the new flow `done` already means the PR merged, which the watcher confirms. So done → `closeState` covers it.

**Watcher config.** `config.ts` gains `syncWorkItems: z.boolean().default(true)`, a watcher-wide kill switch. The scope docs gain Work Items (Read & write) for ADO.

### 5. Board UI

**The new section.** In `WorkspacesModal.tsx` `WorkspaceItem`, add a `<details>` "Azure DevOps work items" section, shown only when `workspace.remote?.provider === 'azdo'`. It contains:

- an Enabled toggle;
- comma-separated inputs for types and states;
- the area path, iteration path and required-tag fields;
- an "Assign to" field, with a placeholder saying "PAT owner when blank";
- a stage select (Spec / Implementation);
- the auto-queue checkbox;
- the state mapping: claim, review and close;
- an "Advanced" subsection with the marker tag, order by and the caps;
- a read-only **WIQL preview** of the saved settings, computed server-side with core's `buildInboundWiql`.

**Saving.** The section saves through the existing `api.updateWorkspace`. Its body type is widened to include `adoSync`.

**Other workspaces.** A non-ADO workspace shows a one-line note instead: "Work-item import needs an Azure DevOps origin."

**Help text.** The PAT field's help text notes the extra scope needed: Code and Work Items (Read & write).

### 6. Docs and ado-bridge

- **Design docs.** Write `docs/spec/2026-10-22-ado-work-item-import-design.md` and `docs/plan/2026-10-22-ado-work-item-import-implementation.md` first.
- **AgentFactory docs.**
  - `CLAUDE.md`: update the watcher bullet.
  - `README.md`: add a short section on setting up the import, with a table that maps each old `ado-bridge.config.json` field to its new setting.
- **ado-bridge repo:** a small README note, as a separate commit in that repo, saying that `Run-AdoBridgeLoop` is superseded by the AgentFactory workspace setting. Stop the PowerShell loop for a workspace before enabling the setting. Both are idempotent and use the same `AB#` and tag markers, but running both is pointless.

## Delivery

- Work on branch `feat/ado-work-item-import`, test-first, with Conventional Commits.
- Commit in this order: docs, core, web API and UI, watcher, then docs again.
- Push the branch and open a PR, with no session links.

## Verification

**Tests to write first (RED):**

- **Core:**
  - `buildInboundWiql`, covering all 6 ado-bridge `Test-InboundWiql` cases plus a multi-type case.
  - `htmlToText` (tags, entities, collapsing blank lines, truncation).
  - The settings schema: defaults, `requiredTag` equal to `markerTag` is rejected, a corrupt column reads as null.
  - Migration #27.
  - `importTask`: creates and queues as a human with the `ado-import/v1` comment; with `queue: false` it stays in backlog.
- **Web:**
  - PATCH `adoSync` round-trips.
  - PATCH is rejected (400) for a non-ADO origin.
  - GET returns `remote`.
  - `/api/agent/import-task` needs a supervisor token; check the contract.
  - The client renders the section only for ADO workspaces and saves it.
- **Watcher**, with a fake `fetchJson`:
  - imports a new item;
  - skips an item that already has an `AB#` task;
  - resumes an item it already claimed;
  - drops an item whose rev-test claim was lost;
  - respects the cap;
  - sends review, then close, only from the states the bridge manages;
  - leaves an item that was moved by hand untouched;
  - skips an ADO workspace that isn't enabled, and a non-ADO workspace;
  - pauses on 429 and warns once on an auth error;
  - does nothing when `syncWorkItems` is false.

**Full suite:** `npm run build && npm test && npm -w packages/web run typecheck:client` must all pass.

**Live, read-only check against a real ADO project** (the client workspace whose PAT already exists):

1. Run a scratch-DB board plus one watcher tick in a dry mode. That mode is a test-only `fetchJson` wrapper that logs PATCHes instead of sending them.
2. Confirm the WIQL returns the expected candidates and that the tasks it would create look right.
3. Mutate nothing in ADO without the user's go-ahead.
