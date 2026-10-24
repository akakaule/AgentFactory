# Agent model settings on the board

Status: draft for review, 2026-10-23. UI mockup: https://claude.ai/artifact/HdjPRX8sj9YUdcirCDR2rT (private).
Depends on PR #67, which lets a Claude reviewer take a reasoning effort (`claude --effort`).

## 1. Goal

Today, choosing which model runs each pipeline step means editing two JSON files on the machine that runs the supervisors, then restarting them:

- `dispatcher.config.json` sets `stageEngines` and `stageArgs`.
- `reviewer.config.json` sets `reviewers`, `engine`/`model` and `visualization`.

This feature lets a person set, from the board:

- the **engine, model and effort** for every agent role: spec, implementation, the reviewers, change visualization and the PR feedback evaluator;
- a **per-workspace override** for any of those roles.

Supervisors pick the settings up on their next poll, with no file edit and no restart. The config files stay as the defaults, so a board with no settings behaves exactly as it does now.

The setup the user asked for on 2026-10-23 is the worked example throughout:

| Role | Engine | Model | Effort |
|---|---|---|---|
| Spec (and legacy plan) | Claude | `claude-opus-5-5` | high |
| Implementation | Claude | `claude-opus-5-5` | medium |
| Reviewer 1 | Codex | `gpt-6.1-sol` | high |
| Reviewer 2 | Claude | `claude-opus-5-5` | high |

## 2. How it works today

- **Workers** (`packages/dispatcher`): for each task the dispatcher calls `engineFor(stage)`.
  - The engine comes from `stageEngines[stage] ?? 'claude'`.
  - It is then checked against the board's engine on/off switches with `resolveEngine` (`core/src/engineSettings.ts`).
  - The session runs with the engine's global args (`claudeArgs` / `codexArgs`) followed by `stageArgs[stage]`. The stage args come last, so a stage `--model` wins.
  - **Fallback:** if the configured engine is switched off, the session runs on the other engine and the stage args are dropped, because they belong to the configured engine (`dispatcher.ts` `spawnSession`).
- **Reviewers** (`packages/reviewer`):
  - With `reviewers` set, every profile whose engine is switched on reviews the submission. One remaining profile reviews alone; none means it waits.
  - Without `reviewers`, `engine`/`model` run one review, falling back to the other engine on its default model.
  - Change visualization uses `visualization.engine/model`, and feedback evaluation uses `engine`/`model`, each with the same fallback.
  - Codex effort goes in as `-c model_reasoning_effort="…"`, Claude effort as `--effort …` (PR #67).
- **Board settings that already work this way:**
  - The engine on/off switches live in `app_kv` key `engine_settings`.
  - Supervisors read them every tick (`getEngineSettings`, also over `HttpCore`).
  - The UI is the Engines row in the Agents modal.
  - Writes are human-only (`PUT /api/engines`, `rejectService`).
- **Earlier attempt:** branch `feat/supervisor-config-ui` (68660e4, July 2026) made *all* supervisor tunables editable from the board.
  - It stored a sparse override per supervisor kind in `app_kv` `supervisor_settings`.
  - Each tick, `refreshConfig()` merged that override onto the file config.
  - It was never merged and is far behind `main`. This feature reuses its pattern (sparse override, merged each tick, file as default) but is limited to models, and is built fresh on `main`.

## 3. Decisions

1. **The board stores overrides; the config files stay the defaults.** For each role, the effective setting is the first one that exists, in this order:
   1. the workspace's override;
   2. the board's global setting;
   3. the supervisor's config file;
   4. the CLI's own default.

   Clearing a board setting goes back to the file. "Reset to config files" clears all global board settings.
2. **Storage is one `app_kv` document, `agent_models`, holding both the global settings and the per-workspace overrides.**
   - **No migration.** The migration head is #28, and parallel branches have collided on migration slots before.
   - **Updated in one write.** A save is all-or-nothing.
   - **One read per tick** for each supervisor.
   - Workspace names cannot be renamed, so keying overrides by name is stable. Overrides for a deleted workspace are ignored and dropped on the next save.
   - Like `engine_settings`, `app_kv` is outside `getVersion()`. The modal re-reads the document when it opens; supervisors read it every tick.
3. **A role is described by fields, not free-form CLI arguments.** A role is `{ engine, model?, effort? }`. The supervisors turn those into the engine's own flags (§5.4), so the UI never edits raw arguments and the board never builds a shell string.
4. **The model list is a fixed catalogue plus "Custom model id…".** The catalogue lives in core (§4.3) and gives the dropdown its labels. A custom id lets a newly released model be used without an AgentFactory release. Model ids are restricted to a safe set of characters (§8).
5. **Per-workspace overrides are set per role.** Review is one role: a workspace overrides the **whole reviewer list**, never "reviewer 2" on its own. An override by position would silently point at a different reviewer once the global list changes.
   - **This differs from the mockup**, whose workspace screen lets you toggle each reviewer separately. The canvas needs updating to match.
6. **Changes apply to the next session.** A session that is already running keeps its model. Supervisors read the settings each tick, just as they read the engine switches.
7. **Only people can write the settings.** An agent must not be able to choose its own model or effort, so writes are refused for service tokens. Supervisors only read.
8. **The engine on/off switches still take priority.** A role whose engine is switched off follows today's fallback rules (§5.3), and the UI says what will happen.

## 4. Data model (core)

### 4.1 Types: `packages/core/src/agentModels.ts`

```ts
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORTS)[number];

/** One agent role's engine choice. model/effort omitted = the engine's own default. */
export interface ModelProfile { engine: AgentEngine; model?: string; effort?: Effort }

/** Settings for the roles. Every key is optional: a missing one falls through to the next layer. */
export interface AgentModelLayer {
  stages?: { description?: ModelProfile; plan?: ModelProfile; implementation?: ModelProfile };
  reviewers?: ModelProfile[];      // ordered; 1..4; distinct engine+model pairs (same rule as reviewer config)
  consensus?: boolean;             // overrides reviewer.config consensus.enabled; its timing stays file-driven
  visualization?: ModelProfile;
  feedbackEval?: ModelProfile;
}

/** The stored document (app_kv 'agent_models'). */
export interface AgentModels {
  global: AgentModelLayer;
  workspaces: Record<string, Omit<AgentModelLayer, 'consensus'>>;
}
```

- **Legacy plan stage:** an unset `plan` uses the `description` profile, at every layer. That matches the mockup's "Plan stage (legacy): same as Spec".
- **Consensus round:** whether it runs is global only. Per-workspace control is out of scope.

### 4.2 Validation

Validation uses zod and follows `parse()`, so a bad value raises `ValidationError` and the API answers 400.

| Field | Rule |
|---|---|
| `engine` | `claude` or `codex` |
| `model` | Matches `^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,79}$`. This allows ids such as `claude-opus-5-5`, `gpt-6.1-sol` and `claude-opus-5-5[1m]`, and rejects spaces, quotes, `=`, `;`, `&`, `|`, `%`, `^` and newlines (§8). |
| `effort` | One of `EFFORTS` |
| `reviewers` | 1 to 4 entries, no duplicate engine+model pair |
| workspace keys | Must name an existing workspace at save time |
| unknown keys | Rejected (`.strict()`) |

A stored document that is corrupt, or no longer valid, reads as `{ global: {}, workspaces: {} }`, so everything falls through to the config files. This is the same rule `engine_settings` uses.

### 4.3 Catalogue: `MODEL_CATALOG`

The catalogue is only for display: dropdown labels and the order of the list. Supervisors never check a model id against it.

| Engine | Id | Label |
|---|---|---|
| claude | `claude-opus-5-5` | Opus 5.5 |
| claude | `claude-sonnet-5-5` | Sonnet 5.5 |
| claude | `claude-haiku-5-5` | Haiku 5.5 |
| claude | `claude-fable-5-1` | Fable 5.1 |
| codex | `gpt-6.1-sol` | GPT-6.1 Sol |
| codex | `gpt-6-sol` | GPT-6 Sol |
| codex | `gpt-6-astra` | GPT-6 Astra |
| codex | `gpt-6-luna` | GPT-6 Luna |

### 4.4 Core ops

- `getAgentModels(): AgentModels`: the stored document, with corrupt values normalized.
- `setAgentModels(doc: unknown): AgentModels`: validates, removes workspaces that no longer exist, and replaces the whole document. A save always sends the full document. This avoids lost updates between the modal's two scopes; a newer save from another tab wins.
- `resolveAgentModel(role, workspace, fileDefault): ModelProfile | null`: the precedence rule from decision 1, written once so the dispatcher and reviewer share it. Its argument types:
  - `role` is `'description' | 'plan' | 'implementation' | 'visualization' | 'feedbackEval'`.
  - Reviewers have their own `resolveReviewers(workspace, fileReviewers)`.
- `reportAgentModelDefaults(report)` and `getAgentModelDefaults()`: see §6.

## 5. How supervisors apply it

Each tick, the dispatcher and reviewer read `getAgentModels()` once, as they already read `getEngineSettings()`. They then resolve each role for each task's workspace.

### 5.1 Dispatcher (workers)

For each claimed task, the dispatcher resolves `resolveAgentModel(stage, workspace, fileProfile(stage))`. Here `fileProfile(stage)` is the profile the config file describes for that stage (§6).

- **When a board layer supplies the profile:**
  - The engine is `profile.engine`, not `stageEngines[stage]`.
  - The file's `stageArgs[stage]` are **not** used. They express model and effort, which the board now owns, and passing both would send two `--model` flags.
  - The global `claudeArgs` / `codexArgs` still apply (permissions and so on), followed by the profile's flags (§5.4).
- **When no board layer applies:** the dispatcher behaves exactly as today. This keeps backward compatibility; the existing dispatcher tests stay unchanged.
- `engineFor(stage)` changes to `engineFor(stage, workspace)`, because the engine can now differ by workspace. The poll-time check that "some engine can run this stage" uses the same resolution.

### 5.2 Reviewer

- **Review:** the reviewer list is `resolveReviewers(workspace, config.reviewers)`.
  - It takes the workspace's list if one is set, else the board's global list, else `config.reviewers`.
  - If none of those exist, it uses a single profile from `config.engine` / `config.model`.
  - `activeReviewers()` becomes per workspace; today it is computed once per tick.
- **Consensus round:** `consensus` on the board, if set, replaces `config.consensus.enabled`. When the file has no `consensus` block, the file schema's defaults (30 minutes, 500,000 characters) apply.
- **Change visualization** and **feedback evaluation** use `resolveAgentModel('visualization' | 'feedbackEval', …)`. Their file fallbacks are what they are today: for visualization, `visualization.engine ?? engine` with `visualization.model ?? model`; for feedback evaluation, `engine` with `model`.

### 5.3 When an engine is switched off

| Role | Engine of the resolved profile is off | Same as today? |
|---|---|---|
| Spec / plan / implementation | The other engine runs with **its default model and effort** (the profile is dropped). If both are off, the task waits. | yes |
| A reviewer in the list | That reviewer is skipped. One remaining reviewer reviews alone; none means the review waits. | yes |
| Visualization / feedback evaluation | The other engine runs with its default model. | yes |

The Models tab shows these outcomes inline (mockup: the amber notes).

### 5.4 Turning a profile into CLI flags

These flags are appended last, after the engine's global args.

| Engine | `model` | `effort` |
|---|---|---|
| claude (worker and reviewer) | `--model <model>` | `--effort <effort>` |
| codex (worker and reviewer) | `-m <model>` | `-c model_reasoning_effort="<effort>"` |

- The Codex `-c` value already goes through the existing path that avoids cmd.exe (`codex.ts`: "never pass TOML overrides through cmd.exe").
- On Windows, a Claude model id may pass through the `.cmd` shim, which is why its characters are restricted (§8).
- A field that is not set adds no flag.

## 6. Showing config-file defaults on the board

The board does not read the supervisors' config files: supervisors may run on another machine (board mode). To show "from reviewer.config.json" and the value it holds, each supervisor reports its defaults:

- On startup, and whenever its config reloads, a supervisor calls `reportAgentModelDefaults({ supervisor: name, kind, at, roles })`.
  - `roles` maps each role the supervisor serves to the profile its file describes. Arguments that cannot be parsed go in an `extraArgs: string[]` field, so nothing is hidden.
  - **Dispatcher:**
    - The engine is `stageEngines[stage] ?? 'claude'`.
    - The model and effort are parsed from `<engine global args> + stageArgs[stage]`, and the last value wins.
    - For Claude it reads `--model` and `--effort`. For Codex it reads `-m`/`--model` and `-c model_reasoning_effort=…`.
  - **Reviewer:** `reviewers`, or `engine`/`model`, plus `visualization` and the consensus flag.
- The report is stored in `app_kv` `agent_model_defaults`, keyed by supervisor name with the time it arrived. It needs a service token; a plain token is enough, because the report is informational and changes nothing.
- **What the UI shows:**
  - For a role not set on the board, it shows the reported default and the supervisor it came from.
  - If several supervisors report different defaults for the same role, it shows "varies by supervisor".
  - With no report, it shows "Uses the config file (no supervisor has reported yet)".

## 7. API

| Method and path | Who | Purpose |
|---|---|---|
| `GET /api/agent-models` | user | Returns `{ settings: AgentModels, defaults: <reported>, catalog: MODEL_CATALOG }` |
| `PUT /api/agent-models` | user (`rejectService`) | Replaces the whole document. Invalid input answers 400. |
| `GET /api/agent/agent-models` | service | Read-only, for supervisors in board mode |
| `POST /api/agent/agent-models/defaults` | service | A supervisor's defaults report |

- **`HttpCore`** gains `getAgentModels` and `reportAgentModelDefaults`.
- **The supervisors' slice types** gain the same two methods, and the HttpCore contract test covers both.
- **Errors** map as usual: `ValidationError` answers 400.

## 8. Security

- **Who can change models:** an agent cannot change its own or another agent's model or effort, because writes refuse service tokens (decision 7). The board session is the only writer.
- **Model ids end up as process arguments.**
  - On Windows, Claude may be spawned through a `.cmd` shim, and so through `cmd.exe`. `dispatcher/src/claude.ts` prefers `claude.exe` when it is on PATH and falls back to `claude.cmd`.
  - The model pattern therefore excludes every character `cmd.exe` interprets or that could split an argument.
  - Effort is a closed list.
  - Nothing the board stores becomes a shell string.
- **No secrets are stored:** profiles hold engine, model and effort only, never tokens or arguments.

## 9. UI

The canvas linked at the top is the reference design.

### 9.1 Agents → Models tab (global)

- **Placement:** the Agents modal gets two tabs, **Models** and **System prompts**. System prompts is today's content, and the Engines row moves to the top of the Models tab.
- **One card per pipeline step**, in pipeline order (1 Spec, 2 Implementation, 3 Review). Each card has:
  - **Engine:** a two-option switch, Claude / Codex.
  - **Model:** a dropdown of the catalogue entries for that engine, plus "Custom model id…", which reveals a text field checked live against the §4.2 pattern.
  - **Effort:** buttons for low, medium, high, xhigh and max, plus "Default", which leaves effort unset.
  - **Command preview**, in monospace, e.g. `claude -p --model claude-opus-5-5 --effort high`. It shows only the parts this feature controls.
  - **A source chip:** "set on board", or "from dispatcher.config.json · <supervisor>" (§6).
  - **"Use config file"**, shown when the step is set on the board. It clears that one global setting.
- **Review card:**
  - An ordered list of reviewers, each with the same three controls and a Remove button (up to 4).
  - "+ Add reviewer".
  - A "Consensus round" checkbox.
- **Engine warnings:** when the engine a card uses is switched off, the card shows the §5.3 outcome as a note.
- **Other agents (collapsed):** change visualization and the PR feedback evaluator, with the same controls, plus a read-only line "Plan stage (legacy): same as Spec".
- **Footer:**
  - an unsaved-change count;
  - **Reset to config files**, which clears the whole global layer after a confirm built into the page;
  - Cancel and Save.
  - Save sends the full document (§4.4) and shows server errors inline.

### 9.2 Workspaces → Edit → Agent models (per workspace)

- **Placement:** a section next to the existing prompt overrides, with the summary "N of M steps overridden".
- **One row per role** (Spec, Implementation, Review, plus Other agents collapsed). Each row shows "Uses global: …", or the override's controls when "Override for this workspace" is ticked.
- **Review:** ticking the override copies the current global reviewer list into the workspace, where it can be edited as a list (decision 5).
- **Saving** goes through the same `PUT /api/agent-models`, with only this workspace's entry changed in the document the modal loaded.

## 10. Out of scope

- **Other supervisor settings** (poll intervals, concurrency, time limits, attempts). That is what `feat/supervisor-config-ui` covered; reviving it is a separate decision.
- **Raw CLI arguments in the UI.** `claudeArgs`, `codexArgs` and any non-model `stageArgs` stay in the files.
- **Task Intelligence (intake) models.**
- **Reading model lists from the CLIs.** The catalogue is static, with a custom id as the escape hatch.
- **Recording which model a session actually used** in its transcript or metrics. This is a useful follow-up, so the board could show "ran on claude-opus-5-5 · high".
- **Switching a running session's model.**

## 11. Acceptance criteria

1. **Board setting reaches the worker.** With the global Spec set to Claude `claude-opus-5-5` high, the dispatcher's next spec session for any workspace launches with `--model claude-opus-5-5 --effort high` after the global `claudeArgs`, and without that stage's file `stageArgs`.
2. **Workspace override wins.** With kl-dis overriding Implementation to Claude `claude-sonnet-5-5` medium, implementation sessions for kl-dis use it, and every other workspace uses the global or file setting.
3. **Back-compatible.** With no board settings, the dispatcher and reviewer launch with exactly the same arguments as before this change; the existing supervisor tests pass unchanged.
4. **Reviewer list.** With the global reviewers set to Codex `gpt-6.1-sol` high and Claude `claude-opus-5-5` high:
   - the reviewer runs both on each submission and posts one combined verdict;
   - Codex launches with `-m gpt-6.1-sol -c model_reasoning_effort="high"`;
   - Claude launches with `--model claude-opus-5-5 --effort high`.
5. **Engine off.** With Codex switched off:
   - reviewer 1 is skipped and reviewer 2 reviews alone;
   - a step whose resolved engine is Codex runs on Claude at its default model;
   - the Models tab shows both outcomes.
6. **Validation.** `PUT /api/agent-models` answers 400 for:
   - a model id containing a space, quote, `&`, `|`, `%`, `^` or a newline;
   - an unknown effort;
   - more than 4 reviewers, or duplicate reviewers;
   - an unknown workspace;
   - an unknown key.
7. **Only people write.** A service token gets 403 on `PUT /api/agent-models`. Supervisors read through `/api/agent/agent-models` and never write the settings.
8. **No restart.** A saved change is used by the next session the supervisor starts after its next poll, without restarting it.
9. **Defaults visible.** After the supervisors start, the Models tab shows each role's config-file default and the supervisor it came from. With no report, the tab says so.
10. **Corrupt document is harmless.** A stored `agent_models` that is not valid JSON or fails validation reads as empty, so supervisors fall back to their files and keep running.
11. **Board mode.** The dispatcher and reviewer running against the board over HTTP get the same results as in DB mode (`HttpCore` contract test).

## 12. Testing

- **core:**
  - schema accept and reject tables (§4.2);
  - normalizing a corrupt document;
  - the precedence rule in `resolveAgentModel` and `resolveReviewers`, including the plan stage falling back to Spec;
  - parsing the defaults report from file configs, including the "last value wins" cases.
- **web:** routes, the service-token boundary, and the HttpCore contract.
- **Client:**
  - the Models tab renders the stored settings, defaults and warnings;
  - Save sends the full document;
  - Reset clears the global layer;
  - the workspace section's override toggle copies the global settings.
- **dispatcher and reviewer:** the arguments built for each acceptance criterion, using the existing fake spawn.

## 13. Rollout

1. Merge PR #67, or fold it into this work. Without it a Claude reviewer cannot take an effort.
2. Build behind no flag. With an empty `agent_models` document nothing changes (AC3).
3. Deploy: rebuild, then restart `:8787` (new routes), the dispatcher and the reviewer (new reads and the defaults report).
4. Optional clean-up: once the board holds the settings, the local `dispatcher.config.json` / `reviewer.config.json` model settings can stay as a fallback or be removed.
