# AgentFactory — Agent-Loop Task Board

**Date:** 2026-06-09
**Status:** Approved design, ready for implementation planning

## Summary

A Linear-style task board for feeding tasks to — and following up on tasks given to —
an agent loop ([loop engineering](https://addyosmani.com/blog/loop-engineering/)). The tool
is the **persistent state store + UI** described in loop engineering: the human writes tasks
and reviews results; an external agent loop reads queued work and reports progress back. The
tool itself never runs agents — it is the board the loop reads from and writes to.

The agent's interface is an **MCP server**, so an MCP-aware runtime (e.g. Claude Code) sees
the board as a set of native callable tools.

## Goals

- Make it easy to write well-specified tasks (spec + acceptance criteria) and release them to an agent loop.
- Give the agent a clean, minimal MCP interface to pull the next task, post progress, and submit results.
- Make the "follow up" loop first-class: review an agent's result, approve it, or send it back with feedback that the agent sees on its next pass.
- Stay simple: single user, runs locally, one source of truth.

## Non-Goals (v1)

All of these are deliberately deferred and can be grown into later:

- Authentication / multi-user / sharing
- Projects or multiple boards (v1 is one flat board)
- Priority levels and manual drag-to-rank ordering (v1 ordering is FIFO)
- Labels / tags
- Task dependencies ("blocked by")
- Agent-created tasks / auto-discovery Inbox (this is the heavier lifecycle "C")
- Scheduled automations
- Git worktree / branch / PR orchestration (the external loop owns execution)

## Context & Decisions

| Decision | Choice |
|----------|--------|
| Tool's role | **State store + UI only.** An external agent loop does the work; the tool stores state and renders the board. |
| Scale & deployment | **Single user, local.** Local web app + local SQLite file. No auth. Agent loop runs on the same machine. |
| Agent interface | **MCP server** (stdio), launched by the agent runtime. |
| Task lifecycle | **Review loop** (see below). |
| Task fields | **Spec + acceptance criteria**, and **result summary + activity thread**. No priority/labels/dependencies. |
| UI default | **Grouped list + detail panel** (Linear default), with a **board view** toggle. |
| Stack | **TypeScript end-to-end.** Shared `core` module; `mcp` and `web` adapters; React + Vite UI. |

## Task Lifecycle

```
Backlog ──► Queued ──► In Progress ──► In Review ──► Done
              ▲            │                │
              │            ▼                │
              │         Blocked             │
              └─────────────────────────────┘
                 "request changes" sends the task
                 back to Queued with feedback attached
```

- **Backlog** — being written / not yet released to the agent. (human-driven)
- **Queued** — ready for the agent; the oldest Queued task is the next one claimed. (human-driven)
- **In Progress** — claimed by the agent and being worked. (agent-driven)
- **In Review** — agent submitted a result; awaiting human review. (agent-driven entry)
- **Done** — approved by the human. Terminal.
- **Blocked** — agent could not proceed; exception state off In Progress. (agent-driven)

**Valid transitions** (enforced in `core`):

- `backlog → queued` (human)
- `queued → in_progress` (agent, via claim)
- `in_progress → in_review` (agent, via submit_result)
- `in_progress → blocked` (agent)
- `blocked → in_progress` (agent, on retry) and `blocked → queued` (human re-release)
- `in_review → done` (human approve)
- `in_review → queued` (human request changes; feedback written to activity thread)

Any other transition is rejected.

## The Feed-and-Follow-Up Loop

1. Human writes a task (Backlog): title, spec, acceptance criteria. Moves it to **Queued** when ready.
2. Agent loop calls **`get_next_task`** → atomically claims the oldest Queued task (`queued → in_progress`) and receives the spec, acceptance criteria, **and the recent activity thread** (so prior review feedback is visible).
3. Agent works, posting progress via `add_comment`, then calls **`submit_result`** → attaches a summary + links, moves `in_progress → in_review`.
4. Human reviews in the UI: **Approve** (`→ done`) or **Request changes** (writes feedback to the thread, `→ queued`).
5. The next `get_next_task` re-surfaces that task with the new feedback. The loop repeats until Done.

## Architecture

Three TypeScript units over a single SQLite file:

```
        ┌─────────────┐        ┌──────────────────┐
        │  MCP server │        │  Web backend     │
        │  (stdio)    │        │  (HTTP + SSE)    │
        │  ← agent    │        │  ← React UI      │
        └──────┬──────┘        └────────┬─────────┘
               │   both import           │
               └──────► core ◄───────────┘
                  (schema · migrations ·
                   domain ops · validation)
                        │
                   SQLite (WAL)
```

### `core`

The only unit that knows the schema and the rules. It owns:

- The SQLite schema and migrations.
- Domain operations, each of which validates the transition and appends to the activity thread:
  - `createTask({ title, spec, acceptanceCriteria })`
  - `listTasks({ status? })`
  - `getTask(key)` — full detail incl. activity thread
  - `claimNextTask()` — atomically claims oldest Queued → In Progress, returns full task + recent activity
  - `addComment(key, { actor, body })`
  - `submitResult(key, { summary, links })` — In Progress → In Review
  - `updateStatus(key, status)` — validated transitions only (e.g. → Blocked, Blocked → In Progress)
  - `reviewApprove(key)` — In Review → Done
  - `reviewRequestChanges(key, { feedback })` — writes feedback, In Review → Queued

Keeping all logic here means the loop rules live in exactly one place; the two adapters are thin.

### `mcp`

A thin MCP server (stdio) exposing core operations as tools for the agent:

| Tool | Effect |
|------|--------|
| `list_tasks(status?)` | See the board / find work |
| `get_next_task()` | Claim oldest Queued → In Progress; returns spec + acceptance + recent activity |
| `get_task(key)` | Full task detail incl. activity thread |
| `add_comment(key, body)` | Post a progress note to the thread |
| `submit_result(key, summary, links[])` | Attach result + links, move → In Review |
| `update_status(key, status)` | Limited, validated transitions (→ Blocked, Blocked → In Progress) |

No `create_task` for the agent in v1 (task creation is human-only). Built via `@modelcontextprotocol/sdk`.

### `web`

- **Backend:** Node + Hono. Serves a REST API for the UI and an **SSE** stream for live updates.
- **Frontend:** React + Vite. Default **grouped-list** view + slide-over **detail panel** (spec, acceptance, result, links, activity thread); **board view** (columns by status) one toggle away. Create/edit tasks; move Backlog → Queued; **Approve** / **Request changes** actions on In Review tasks.

### Live updates

The web backend polls a monotonic version — the latest of `max(task.updated_at)` and
`max(activity.created_at)` — every ~1s and pushes changes to the browser over **SSE**; the
browser falls back to plain polling if the stream drops. This keeps the MCP process fully decoupled — it only writes to SQLite and does not
need to know the web server exists — while the board still updates near-instantly as the agent works.

### Concurrency

SQLite runs in **WAL mode** with a `busy_timeout` so the agent (MCP) process and the web process
can both read/write safely. At one-human-plus-one-loop volume, write contention is negligible.

## Data Model

**`task`**

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `key` | text unique | human-facing, e.g. `AF-1` |
| `title` | text | |
| `spec` | text | the description the agent works from |
| `acceptance_criteria` | text | "done when…" the agent can self-check |
| `status` | text | `backlog`/`queued`/`in_progress`/`in_review`/`done`/`blocked` |
| `result_summary` | text null | set on submit_result |
| `seq` | integer | FIFO ordering for `get_next_task` |
| `created_at` | text (ISO) | |
| `updated_at` | text (ISO) | bumped on every change; drives live updates |

**`activity`** — the timeline

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `task_id` | integer FK | |
| `type` | text | `status_change`/`comment`/`result`/`feedback` |
| `actor` | text | `human`/`agent` |
| `from_status` | text null | for status_change |
| `to_status` | text null | for status_change |
| `body` | text | comment / feedback / result text |
| `created_at` | text (ISO) | |

**`link`** — result artifacts the agent attaches

| Column | Type | Notes |
|--------|------|-------|
| `id` | integer PK | |
| `task_id` | integer FK | |
| `kind` | text | `branch`/`pr`/`worktree`/`log`/`url` |
| `label` | text | display text |
| `url` | text | |

## Testing

- **`core`** is the priority for tests: every domain operation, every valid transition, and rejection
  of every invalid transition; `claimNextTask` ordering (FIFO) and atomicity; activity-thread entries
  written for each operation.
- **`mcp`**: each tool maps to the right core op and surfaces errors as proper MCP errors.
- **`web`**: API endpoints map to core ops; SSE emits on change. Light component coverage for the
  list/board/detail views and the review actions.

## Open Questions / Future

- Ordering is FIFO in v1; add priority + manual rank if FIFO proves limiting.
- Agent auto-discovery (Inbox + `create_task`) is the natural first extension (lifecycle "C").
- Projects/multiple boards if more than one loop is run.
