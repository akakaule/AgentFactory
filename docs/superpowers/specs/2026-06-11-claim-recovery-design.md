# AgentFactory — Claim recovery (claim metadata + human release)

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11)
**Grows from:** [2026-06-10 workspaces design](2026-06-10-workspaces-design.md), which deferred
"the `in_progress` crash-recovery gap (no human transition out of `in_progress`) — real,
adjacent, and separate". This is that change.

## Problem

`TRANSITIONS` has no human exit from `in_progress` — the only ways out are
`→ in_review` and `→ blocked`, both agent-only. When a worker crashes, is killed, or
loses its session mid-task, the task is stranded in In Progress **permanently**; the only
recourse is hand-editing the SQLite file. Workspaces made this worse in practice: the
recommended topology is now several parallel pinned workers, so more claims are in flight
at any time and a dead worker wedging its queue is a matter of when, not if.

Adjacent blindness: the board cannot answer *which worker has this task and since when* —
there is no claim metadata at all.

## Goals

- A claimed task records **who** claimed it and **when**; both visible on the board.
- A human can **release** a stranded claim: `in_progress → queued`, preserving all
  activity history, so the next claimant picks it up with full context.
- Agents cannot release claims (it stays a human-judgment rescue, like review).
- Zero new ops/routes/tools where existing machinery already fits.

## Non-Goals (deferred)

- Auto-timeout / lease expiry — single-user tool; the human decides what is stale. No
  background reaper, no heartbeats.
- Worker registry or per-claim history table — the activity log already records every
  transition; `claimed_by/claimed_at` is current-state, overwritten by the next claim.
- Multi-claim / claim queueing — one task, one claimant, as before.

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Representation | Two nullable columns on `task`: `claimed_by TEXT`, `claimed_at TEXT` | Current-state 1:1 with the task; history lives in `activity`. Nullable ADD COLUMN has no SQLite migration gotchas (no defaults, no FK). |
| Release mechanism | **New transition rule** `{ from: 'in_progress', to: 'queued', by: 'human' }` — nothing else | `updateStatus` + the existing `POST /:key/status` route + activity logging all just work. No new core op, route, or MCP tool. Agents can't use it (rule is human-only); MCP `update_status` acts as `agent`. |
| Clearing semantics | Claim fields are **cleared on any transition into `queued`** (single choke point in `setStatus`); they persist through `in_review`/`done`/`blocked` | A queued task with stale claim metadata is a lie; everywhere else it is accurate "last/current claimant" provenance. `blocked` keeps the claim — the worker that blocked it still owns it (it resumes via `blocked → in_progress`). Covers release, request-changes, and `blocked → queued` with one rule. |
| `claimed_by` source | Optional env **`AGENTFACTORY_WORKER`** on the MCP server; falls back to `AGENTFACTORY_WORKSPACE` (the pin is a natural worker label); absent both → `NULL` | Deploy-time identity lives next to the other envs in the worker's MCP config. `claimed_at` is always set on claim regardless — age alone is the load-bearing staleness signal. |
| Payload shape | `Task` gains `claimedBy: string \| null; claimedAt: string \| null` | List rows need it for the board chip; detail inherits via `TaskDetail extends Task`. |
| `claimNextTask` signature | Options object: `claimNextTask(opts?: { workspace?, claimedBy? })` (core surface and db-level fn) | Two optional scalars in positional form is already awkward; the opts object absorbs future claim options. Call sites passing nothing keep working. |
| UI affordance | Detail panel of an `in_progress` task: "Claimed by *label* · *age*" line + **Release claim** button (calls the existing status endpoint); board rows/cards show a small claim chip on `in_progress` tasks | Cheapest possible run-monitoring for a tool that doesn't own agent processes. No new client API. |

## Data model

Migration **#3** (same `PRAGMA user_version` mechanism; migrations #1/#2 stay frozen):

```sql
ALTER TABLE task ADD COLUMN claimed_by TEXT;
ALTER TABLE task ADD COLUMN claimed_at TEXT;
```

Nullable, no defaults, no REFERENCES — none of migration #2's `foreign_keys = ON`
restrictions apply. Existing rows (including any currently stranded `in_progress` tasks)
get `NULL`s; the UI shows an unclaimed in-progress task as exactly that.

- `claimNextTask` sets `claimed_by = opts.claimedBy ?? NULL`, `claimed_at = <claim ts>`
  in the same UPDATE that flips the status.
- `setStatus(db, id, 'queued', ts)` additionally clears both fields — the single choke
  point through which every re-queue path flows (release, request-changes,
  `blocked → queued`).

## Transition change

```
{ from: 'in_progress', to: 'queued', by: 'human' }   // release claim
```

The full human rescue story becomes symmetric: `in_review → queued` (request changes),
`blocked → queued` (re-queue), and now `in_progress → queued` (release a dead claim).

## MCP surface

- `index.ts` reads `AGENTFACTORY_WORKER ?? AGENTFACTORY_WORKSPACE` into
  `ServerOptions.workerLabel`; `get_next_task` passes it as `claimedBy`.
- Claimed payload now carries `claimedBy`/`claimedAt` (via `Task`). No new tools; no
  input-schema changes.

## Web surface

- **Server:** no changes — `POST /:key/status { status: 'queued' }` already exists and
  `InvalidTransitionError → 409` already maps. (One explicit test for the release path.)
- **Client:** DetailPanel `in_progress` section: claimant line ("Claimed by *x* · *N*m
  ago", label omitted when `claimedBy` is null) + **Release claim** button via the
  existing `api.setStatus(key, 'queued')`. TaskRow: muted claim chip on `in_progress`
  rows/cards. SSE refetch keeps ages/chips live.

## Acceptance criteria (feature-level)

1. Fresh DB → `user_version = 3`; an existing v2 DB migrates in place with `NULL` claim
   fields on all tasks; full suite green.
2. A claim records `claimed_at` always, and `claimed_by` when the worker is labeled
   (env or explicit option); both appear in the claimed MCP payload and in list rows.
3. A human can release an `in_progress` task to `queued` through the existing status
   endpoint; claim fields are cleared; an agent attempting the same transition is
   rejected.
4. Every path into `queued` clears claim metadata; the next claim overwrites it.
5. After release, a new worker's claim sees the task's full prior activity (the
   feed-and-follow-up loop survives a dead worker).
6. UI: in-progress detail shows claimant + age + Release claim; board shows the claim
   chip; unclaimed or non-in-progress tasks show nothing new.
