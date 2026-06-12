# AgentFactory — Dispatcher: one fresh session per task

**Date:** 2026-06-12
**Status:** Proposed
**Grows from:** [2026-06-11 claim recovery](2026-06-11-claim-recovery-design.md) (whose
stranded-claim rescue this automates), [2026-06-11 analytics](2026-06-11-analytics-design.md)
(whose metrics this feeds with measured numbers), and the same 2026-06-12 staleness incident
as [claim protocol + guardrails](2026-06-12-claim-protocol-and-submit-guardrails-design.md) —
that design makes staleness harmless; this one makes it structurally impossible.

## Problem

Workers today are hand-started, long-lived interactive Claude sessions that claim task
after task. Four costs:

1. **Staleness by construction.** Tool descriptions and the MCP server process freeze at
   session start; a worker running since yesterday follows yesterday's rules (root cause
   of the unpushed-branch incident).
2. **Crash = stranded claim.** A dead session leaves its task `in_progress` until a human
   notices and releases it.
3. **Costs are guesses.** Metrics ride `submit_result` as agent self-estimates; one session
   spanning many tasks can't attribute its usage per task.
4. **Scaling is babysitting.** More throughput means opening another terminal and watching it.

## Goals

- Queue → in_review with no human in the loop: a supervisor watches the queue and spawns a
  **fresh headless session per task** (`claude -p`).
- Structural staleness immunity: every task's session is born with the current MCP build,
  descriptions, and protocol.
- **Measured** per-task metrics from the CLI's own usage report, replacing self-estimates.
- Crash containment: a dead session costs one attempt on one task, and the dispatcher —
  which *knows* the session died — releases the claim with the log tail attached.

## Non-Goals (deferred)

- Multi-machine scaling, queue priorities, task dependencies.
- A dispatcher UI on the board (worker labels + analytics already surface activity).
- CI/PR integration (separate designs).
- Replacing interactive workers — supervised sessions remain fine for exploratory work.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Home | New `packages/dispatcher`, bin `agentfactory-dispatcher` | Own lifecycle and config; zero coupling to the web server |
| Queue detection | Poll the DB read-only via `@agentfactory/core` (`listTasks` status=queued per configured workspace), default every 15 s | Works with the web server down; SSE subscription is a later optimization, not a dependency |
| Who claims | The **spawned session**, via `get_next_task` — the dispatcher never claims | Claim atomicity, the protocol payload, and attribution all ride the existing path; N racing sessions get N distinct tasks or `{task:null}` and exit cleanly |
| Session shape | `claude -p <worker prompt> --output-format json --permission-mode <cfg>`, cwd = workspace `repoPath`, `--mcp-config` with the agentfactory server inline, env `AGENTFACTORY_WORKSPACE=<ws>`, `AGENTFACTORY_WORKER=<ws>#<key>-a<attempt>` | Fresh session per task; cwd = repo means the target repo's `.claude` settings and allowlists apply; the worker label makes every attempt attributable on the board |
| One task per session | Worker prompt: claim exactly one task → work it through `submit_result` → exit; dispatcher spawns at most `min(queuedCount, maxConcurrent)` sessions | Spawn gating + prompt discipline; DB claim atomicity makes over-spawn harmless |
| Concurrency | `maxConcurrent` per workspace, **default 1** | Shared local resources (PMD's test DBs and ports) make same-repo parallelism opt-in, not default |
| Metrics | Parse the CLI's JSON result (cost, tokens, duration) → `core.addTaskMetrics` after the session exits | Authoritative numbers; the agent may still self-report, the dispatcher's measured values win |
| Crash / timeout | Child exits non-zero (or exceeds `maxSessionMinutes`, default 60 → kill) with its task still `in_progress` under its label → comment with the log tail → release the claim (`in_progress → queued`) → increment an in-memory attempt counter; after `maxAttempts` (default 2) stop serving that task and warn on the console | Automates exactly what claim recovery asks a human to do, on a signal only the supervisor has; the attempt cap prevents crash loops; in-memory is acceptable v1 (a dispatcher restart resets counts) |
| Logs | `logs/<key>-attempt-<n>.log` per session (stdout+stderr, streamed) | Postmortems; the release comment quotes the tail |
| Config | `dispatcher.config.json`: `db`, `workspaces[]`, `maxConcurrent`, `pollSeconds`, `permissionMode`, `claudeArgs`, `maxSessionMinutes`, `maxAttempts` | One file; restart to apply |

## Permissions note

Unattended sessions only get as far as the target repo's allowlist lets them — build/test
commands must be allowlisted in the repo's `.claude/settings*.json` (PMD's already is,
from interactive use). `permissionMode` defaults to `acceptEdits`; `bypassPermissions` is
supported but documented as for contained environments only.

## Lifecycle sketch

1. Poll: queued task in workspace `pmd`? → spawn session (cwd `C:\Git\AKP\PMD`).
2. Session: `get_next_task` → protocol payload → work → push → `submit_result` (+ links) → exit 0.
3. Dispatcher: reap exit, parse the JSON result, `addTaskMetrics`, archive the log.
4. Crash path: exit ≠ 0 and the task is still `in_progress` under this attempt's label →
   comment + release + attempt++; skip-list after `maxAttempts`.

## Acceptance criteria (feature-level)

1. With the dispatcher running and a task queued, the task reaches `in_review` with no
   human action; the board shows the dispatcher's worker label; metrics are populated from
   the CLI usage report.
2. Two queued tasks with `maxConcurrent: 2` proceed concurrently on distinct branches with
   no claim collision.
3. A session killed mid-task: claim released within one poll cycle with a log-tail comment;
   the task is retried; after `maxAttempts` it stays queued, skip-listed, with a console warning.
4. Empty queue ⇒ no sessions spawned; a spurious spawn (lost race) exits cleanly on `{task:null}`.
5. Dispatcher unit tests cover spawn gating, the crash path, and metrics parsing with a
   faked subprocess; full suite green.
