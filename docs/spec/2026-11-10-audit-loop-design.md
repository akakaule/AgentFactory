# Audit loop design: one model finds, another fixes

**Date:** 2026-11-10
**Status:** Draft for review
**Command:** [`.claude/commands/audit.md`](../../.claude/commands/audit.md)
**Runner:** [`scripts/audit.sh`](../../scripts/audit.sh)
**Profile format:** [`docs/audit-profile.md`](../audit-profile.md)

## 1. Goal

Run a standing loop that keeps a workspace's repository improving without a person writing every ticket:

1. **Find.** An auditor model audits one area of the repository through one lens: security, performance, bugs, simplification or tests.
2. **Verify.** A second, independent pass tries to disprove each candidate. Only findings that survive are kept.
3. **Hand off.** Each surviving finding becomes a backlog task through MCP `create_task`.
4. **Fix.** The dispatcher runs the implementer on the task: regression test first, then the fix, then the workspace's `verifyCommand`.
5. **Review and deliver.** The reviewer reviews against the original finding, a person approves, and the watcher opens the PR.
6. **Learn.** Merged and cancelled audit tasks feed the next run's dedup, so declined findings are not raised again.

The loop is generic. Everything specific to one repository (its areas, its rules, its build commands) lives in that workspace's **audit profile** (section 4), not in AgentFactory and not in this command.

## 2. Non-goals

- No new orchestrator. The board, dispatcher, reviewer and watcher already own claiming, retries, worktrees, cost metrics, review and PR delivery. The auditor only files tasks.
- No automatic queueing. `create_task` files into **Backlog**, and a person queues each task. That is the main noise filter and it stays.
- No whole-repo sweeps. Every run covers one area and one lens.
- No core or schema change in phase 1. The only MCP change is the `archived` argument on `list_tasks` (section 8). Phase 2 (section 11) is a separate spec.
- Nothing in the audited repository. A repository does not need to know AgentFactory exists. It may hold its own audit profile, but the profile must not mention the board.

## 3. Roles and models

| Role | Runs in | Default model | Permissions |
|---|---|---|---|
| Auditor (find + verify) | `scripts/audit.sh` (`claude -p`) in a clean checkout of the workspace's base branch | `claude-fable-5-2`, effort high (`AUDIT_MODEL`, `AUDIT_EFFORT`) | Read-only tools, the profile's build and test commands, read-only `git`, and MCP `list_tasks`, `get_task` and `create_task` |
| Spec writer (description stage, large findings only) | Dispatcher | Workspace's spec-stage model (Agents › Models) | Existing worker profile |
| Implementer | Dispatcher | Workspace's implementation model | Existing worker profile |
| Reviewers | Reviewer | Workspace's reviewer models | Existing reviewer profile |
| Gate | Person | | Queues tasks, approves implementation, merges the PR |

Using the same model family to find a defect and review its fix risks anchoring. Configure a reviewer from a different family for audited workspaces, and keep the implementation gate human.

## 4. The audit profile

A profile is a Markdown file with fixed sections ([`docs/audit-profile.md`](../audit-profile.md)):

- **Rules:** documents the auditor reads first (contributor guide, agent instructions, versioning policy).
- **Areas:** slug, the source paths and the test paths for each area.
- **Where to look:** per lens, the hot spots worth reading first. Optional; the command has generic defaults.
- **Exclusions:** findings never to file in this repository (non-goals, generated files, API policies).
- **Verify:** the build and test commands, quoted into acceptance criteria. Name the commands for each area when they differ.
- **Limits:** the WIP cap and per-run cap, when the defaults (5 and 3) do not fit.

The runner looks for the profile, in order:

1. `--profile <path>`.
2. `<repo>/.agents/audit-profile.md`, when the repository chooses to own it.
3. `~/.config/agentfactory/audit/<workspace>.md`, the machine default.

A run without a profile stops before it reads any code.

## 5. Rotation

Each run audits one cell of the profile's **area × lens** grid. A timer can pick the cell from the date, so nothing has to be stored between runs: `cell = (day-of-year × runs-per-day + run-index) mod (areas × 5)`. Phase 1 has no timer (section 10); a person picks the cell.

## 6. The finding contract

A candidate becomes a finding only if it has every field below. The command drops candidates that are missing any of them.

| Field | Content |
|---|---|
| `lens`, `area` | From the run's arguments |
| `title` | One claim, at most 80 characters, stated as the defect ("Resolver drops the audit entry when …") |
| `location` | `path:line` and the symbol |
| `evidence` | The code path quoted or cited, with the call chain that reaches it |
| `failure` | Concrete input or state, then the wrong result. For performance, the cost and the hot path. For tests, the mutation that survives today. |
| `proof` | The regression test that fails on the base branch today, named and sketched. For performance, the measurement that shows the cost. |
| `fix` | The intended direction, not the code |
| `scope` | Files expected to change, and whether it touches public API, a persisted contract or a generated-code source |
| `severity` | `critical`, `high`, `medium` or `low` |
| `confidence` | `confirmed` (the verify pass reproduced or traced it) or `plausible`. Only `confirmed` findings are filed. |

### What each lens must show

- **Security.** A path from input an attacker controls (an HTTP request, a message body, CLI arguments, configuration from an untrusted source) to a sink, inside the project's threat model. No defence-in-depth nits below `high`.
- **Performance.** The code is on a hot path (per request, per message, per query, a receive loop). The finding names the cost (allocations, round trips, N+1 queries, lock hold time) and how to measure it. Micro-optimisations off the hot path are dropped.
- **Bugs.** A concrete input or state, the wrong output, and a test that fails today.
- **Simplification.** Behaviour stays the same and the change deletes more than it adds. Existing tests cover the behaviour, or the task adds a characterization test first. Public API follows the repository's deprecation policy.
- **Tests.** Names a behaviour or branch with no test, or a test that cannot fail, plus a realistic mutation that survives today. Raising coverage numbers alone does not count.

Every lens also excludes what a compiler or analyzer already reports, and everything in the profile's **Exclusions**.

## 7. Hand-off to the board

### Title and fingerprint

The title is `[audit:<lens>:<area>] <claim>`. The spec's first line carries a fingerprint:

```
Fingerprint: audit/<lens>/<area>/<path>#<symbol>
```

### Spec body

```markdown
Fingerprint: audit/bugs/resolver/src/Resolver/ResolverService.cs#HandleAsync

**Lens:** bugs · **Severity:** high · **Found:** 2026-11-10 on <base>@<sha> by <auditor model>

## Defect
<title restated in one or two sentences>

## Evidence
<path:line, call chain, quoted lines>

## Failure scenario
<input/state → wrong result>

## Proof
<regression test name and sketch; for performance, the measurement>

## Fix direction
<intended direction; files in scope>

## Constraints
<the profile's exclusions and rules that apply to this fix>
```

### Acceptance criteria

Required when the task enters at `implementation`:

1. A regression test named in **Proof** is added first and fails on the base commit. For performance, the measurement is recorded before and after.
2. **If the test cannot be made to fail on the base commit, stop.** Submit "not reproduced" with what was tried. Do not change product code.
3. The fix makes the test pass without weakening any existing test.
4. The profile's **Verify** commands for the area pass. The submission summary states the build and test results, and reports skipped tests per test project with the count and the reason.
5. The change stays inside the files listed in **Fix direction**, or explains why it could not.

### Stage selection

| Finding | `create_task` stage | Why |
|---|---|---|
| Expected scope up to 4 files, no public API, persisted contract or generated-code source change | `implementation` | The finding is already the spec |
| 5+ files, a public API or persisted contract change, a generated-code source, or any `simplification` that moves types | `description` | The spec stage writes a plan and it is AI-reviewed before code |
| `critical` or `high` security | `description`, title prefix `[audit:security-private:<area>]` | Section 13 |

## 8. Dedup and the ledger

Before filing, the auditor calls `list_tasks` for the workspace twice, once as is and once with `archived: true`, and reads each `[audit:` task's fingerprint. Archived tasks are done or cancelled, so they count for dedup but not for the WIP cap.

- **Open task with the same fingerprint** (backlog, queued, in progress, in review, delivering, blocked): skip.
- **Cancelled task with the same fingerprint:** a person declined it, so skip. Cancelling is the rejection ledger and no separate file is needed. Exception: the code at that location changed after the cancellation date (`git log --since`). Then the finding may be filed again, with a note that links the old task.
- **Done task with the same fingerprint:** the fix was merged. File again only if the regression test from that task no longer exists or no longer covers the case. That would be a regression.
- **Same file and symbol under a different lens:** file it, and link the other task in the spec.

`list_tasks` hides archived tasks by default. This spec adds its `archived` argument, which core and the board's `GET /api/tasks` already supported, so archiving an audit task does not remove it from the ledger.

## 9. Limits

- **WIP cap.** If at least 5 `[audit:` tasks are open in the workspace, the run files nothing. A person reviewing PRs is the bottleneck, and the cap keeps the backlog reviewable.
- **Per-run cap.** At most 3 tasks per run, highest severity first.
- **Zero is a valid result.** A run that files nothing because nothing survived verification has succeeded.
- **Budget.** The runner passes `--max-turns` (`AUDIT_MAX_TURNS`, default 200). A timer should also cap wall-clock time.

The profile's **Limits** section overrides both caps.

## 10. Phase 1: running it

Phase 1 is manual. Run audits by hand until their findings are consistently worth merging, then schedule them.

```bash
scripts/audit.sh <workspace> <area> <lens> [--repo <path>] [--profile <path>] [--dry-run]
scripts/audit.sh nimbus resolver bugs --repo ~/src/NimBus --dry-run
```

The runner:

- resolves the profile (section 4) and refuses to run without one;
- warns when the checkout has uncommitted changes, because findings would reflect them;
- uses `AGENTFACTORY_MCP_CONFIG`, or `~/.config/agentfactory/mcp-<workspace>.json`: an MCP config whose server is named `agentfactory` and is pinned to the workspace (`AGENTFACTORY_WORKSPACE`, plus `AGENTFACTORY_DB` or `AGENTFACTORY_BOARD_URL` and `AGENTFACTORY_TOKEN`);
- feeds the command file to `claude -p`, so the audited repository needs no copy of it;
- appends the absolute paths of this spec and the profile format to the prompt, and passes AgentFactory's `docs/` (and the profile's directory, when it is outside the repository) as `--add-dir`, because the auditor runs in the audited repository and cannot otherwise read them;
- allows read-only tools, read-only `git`, the Bash patterns in `AUDIT_BASH_ALLOW` for the profile's build and test commands (default `dotnet build`, `dotnet test`, `npm test`, `npm run`), and the three MCP tools;
- writes the JSON result to `AUDIT_LOG_DIR` (default `~/.config/agentfactory/logs`) and prints the report and its cost.

To run `/audit` interactively from the audited repository, link the command into `~/.claude/commands/`, start `claude` with `--add-dir <AgentFactory checkout>/docs`, and pass the profile path as the first argument.

Not part of phase 1:

- **A timer.** Add one once manual runs are consistently worth merging. It should run the runner from a dedicated clean checkout and pick the cell as in section 5.

## 11. Phase 2: a scout supervisor (deferred)

Once the finding format has held steady for a few weeks, move the runner into a `scout` supervisor, shaped like `intake`:

- A heartbeat on the Live view's health strip, instead of a timer nobody watches.
- Model and effort from the Models tab, as a `scout` role.
- The profile, rotation and caps per workspace on the board, instead of a file on the machine.
- An `externalRef` (fingerprint) column on tasks with a unique index per workspace. That replaces the title-and-spec convention in section 8.
- Audit metrics per lens: filed, queued, merged, cancelled, not reproduced, and cost per merged fix.

This needs its own spec. It is listed here only so phase 1 makes no choice that blocks it: the fingerprint format, the title prefix and the profile sections all carry over.

## 12. How we know it works

Review after four weeks, using the board's task metrics:

| Measure | Target | Action if missed |
|---|---|---|
| Merged ÷ filed, per lens | ≥ 60% | Below 40%: tighten that lens's bar, or drop the lens |
| "Not reproduced" ÷ queued | ≤ 15% | Raise the verify bar; require the verify pass to trace the full path |
| Cancelled as duplicate | ≈ 0 | Fix the fingerprint rule |
| Cost per merged fix | Tracked, no target yet | Compare lenses; drop the most expensive per merge |

## 13. Risks

- **Plausible but wrong findings.** LLM audits produce confident false positives. The defences are the verify pass, the "must name a failing test" rule, the not-reproduced exit, and the human queue gate.
- **Churn from the simplification lens.** It touches the most files and has the highest rejection risk. It goes to `description` for anything that moves types, and public API follows the repository's deprecation policy.
- **Anchoring.** Section 3.
- **Security findings in public.** The watcher opens PRs on the workspace's origin, which may be public. A `critical` or `high` security finding must not go through the open PR flow: the auditor files it at `description` with the title prefix `[audit:security-private:<area>]`, and its spec says to handle it privately (for example a GitHub security advisory and a private fork). The dispatcher must not be left to pick it up; leave it in Backlog.
- **Repository-specific knowledge drifting.** The profile is the only place that knows the repository's layout. Keep it next to whoever maintains that layout, and review it when areas move.
