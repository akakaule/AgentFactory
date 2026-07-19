# Multi-user + remote workers — feature evaluation & roadmap

**Date:** 2026-07-10
**Status:** design/roadmap — nothing in the phases below is built.
**Relation to other docs:** supersedes the *sequencing* section of
[`2026-07-02-remote-execution-aca-sandboxes-design.md`](./2026-07-02-remote-execution-aca-sandboxes-design.md)
(which remains the ACA-specific concretization and the native-cloud fallback for Phase 4) and the parked
phases 3–8 of [`docs/expansion-roadmap.md`](../../expansion-roadmap.md) (multi-tenant SaaS — explicitly
out of scope here, see "Parked").

**Decisions baked in** (product owner, 2026-07-10):

- Multi-user scope is a **trusted team** — a handful of known teammates: token auth + three roles +
  reviewer assignment. SQLite stays. No tenancy, no OIDC, no Postgres.
- Remote workers run on **both** own spare machines **and** ephemeral cloud boxes.
- **crabbox.sh is evaluated, not adopted up front**: the board-side work is identical either way;
  crabbox is prototyped for the cloud-compute layer behind an explicit go/no-go gate, with a native
  (plain-SSH / ACA) fallback.

---

## 1. Where the product stands (evaluation)

### 1.1 What exists — a mature single-operator product

- **Lifecycle state machine** (`packages/core/src/transitions.ts`): `backlog → queued → in_progress →
  in_review → delivering → done` (+ `blocked`), keyed `(from, to, by: 'human'|'agent')`. Humans-only
  approve/reopen/release/force-complete; the watcher owns `delivering → done/queued` — the only
  agent-actor path into `done`.
- **Agent surface**: 8 MCP tools (`packages/mcp/src/tools/*`) with a computed claim protocol
  (PROTOCOL_VERSION 6) that emits exact worktree/push/PR steps as data, and a push-before-review
  submit guardrail (`checkSubmission`).
- **Web UI**: Board / List / Live / Analytics / Telemetry / Archive views; diff (unified + split),
  transcript, change-visualization modals; workspaces, agent-prompts, task-form modals; the
  delivering-feedback loop (paste PR comment → `feedback-eval/v1` → 1-click re-queue); PWA + token
  sign-in.
- **Three supervisors**: dispatcher (one fresh `claude -p`/codex session per task, per-stage engines,
  transcript tail, stale-claim reaper), reviewer (advisory `ai-review/v1` verdicts), watcher (pure
  DB + REST: PR merged + CI green ⇒ done, red build bounces back with captured build errors).
- **Per-workspace discipline**: policy prompt, `verify_command` gate on submit, git PAT (write-only
  over the API), agent-prompt overrides.
- **Derived analytics + telemetry**: metrics/AI-review/failure state parsed from the activity log
  (works retroactively); OTLP `/v1/logs` receiver for Claude/codex token usage.
- Board-editable supervisor settings (live per-tick, no restart) are on branch
  `feat/supervisor-config-ui` (pushed, unmerged at time of writing).

### 1.2 Multi-user: foundation shipped, authorization missing

Already on `main` (migrations #9/#10): `app_user`, sha256-hashed `api_token` (CLI-minted),
`AUTH_MODE=none|token` with a `Principal` of `user | service | anon`
(`packages/web/server/auth.ts`), `activity.actor_user_id` attribution threaded through the human
routes, and the client `TokenGate`. Missing for a second human:

- **No roles** — every authenticated user can approve, delete, reopen, manage workspaces/PATs.
- **No reviewer assignment** — two humans can race approve/request-changes on the same `in_review`
  task (last-writer-wins).
- **No token self-serve** — mint/revoke is CLI-only; no expiry, no last-used.

### 1.3 Remote workers: one hard blocker, seams already cut

**The blocker:** every worker's MCP server and all three supervisors call `openCore(dbPath)` on the
SQLite file directly. There is **no networked claim/submit path** — the web API exposes only the
human/board surface. A worker on another machine cannot claim, submit, report progress, or append a
transcript.

**What is already portable** (verified in code):

- The dispatcher's spawn is fully injected (`SpawnFn`, `DispatcherDeps` in
  `packages/dispatcher/src/types.ts`) and its core access is an explicit interface slice
  (`DispatcherCore`) — the seams for both an HTTP core and a remote spawn profile exist.
- The board's diff is **origin-based** (`branchDiff`/`resolveBaseRef` compute against fetched origin
  refs) — the board never needs the worker's filesystem.
- The watcher is already pure DB + REST — it moves anywhere the DB (or an HTTP core) is reachable.
- `Principal` already distinguishes `service` from `user` tokens — the hook for deriving the
  `human|agent` actor axis server-side (issue #31) is in place.

**Hidden bulk:** the entire `Core` surface is **synchronous** (`node:sqlite`). An HTTP core is
inherently async, so the consumer slices (MCP tools, three supervisors) must become
`Promise`-returning. Mechanical, but it is the real volume of Phase 1.

### 1.4 crabbox.sh — what it is and what it is not

[crabbox](https://crabbox.sh) ([openclaw/crabbox](https://github.com/openclaw/crabbox), MIT, ~1.1k★,
v0.36.0 Jul 2026, active): a remote software-execution control plane — *lease → sync → run →
release*. Go CLI + self-hostable coordinator (Cloudflare Workers + Durable Objects, or
Node + Postgres) that holds provider credentials, authenticates via bearer tokens, and enforces
spend caps / per-user usage accounting. 20+ providers including **static SSH (existing machines, no
provisioning)** and sandbox services (E2B, Daytona, Hetzner, …). Warm-box pools (`crabbox warmup`,
`--id` reuse, idle auto-release), git-aware rsync, evidence capture (logs, JUnit, screenshots,
recordings), live session share.

It is a **command-execution layer, not an orchestrator** — one command per `crabbox run --`, no
task model, no native Claude Code binding. Mapped onto AgentFactory it replaces exactly one thing:
the dispatcher's local child-process spawn.

### 1.5 Build vs adopt — the verdict

The board-side work (authenticated agent ops over HTTP, Phases 1–2) is **identical in every
scenario** and nothing crabbox offers substitutes for it. crabbox is a candidate only for the
**ephemeral-cloud compute layer** (Phase 4), where it would save building provisioning, warm pools,
spend caps, and multi-provider support. Remote workers on machines we own need **zero crabbox** — a
dispatcher per machine over the HTTP core covers them (Phase 2).

So: build Phases 1–3 natively, prototype crabbox in Phase 4 behind the existing `SpawnFn` seam with
explicit exit criteria, and keep a plain-SSH profile / the ACA design as the fallback. Nothing done
for the crabbox path is wasted if it loses — the seam is the same.

---

## 2. The one-sentence architecture shift

Today every process (web server, three supervisors, N worker MCP servers) opens `agentfactory.db`
directly; after Phase 1 the **web server becomes the only DB writer** and everything else — local or
remote, human or agent — talks to it over authenticated HTTP. That single move solves the
remote-worker blocker *and* the SQLite multi-writer contention problem at once.

---

## 3. Phase 1 — Authenticated agent ops over HTTP (`createHttpCore` + #31) — **L**

**Goal.** Any Core consumer can run against the board over the network with a bearer token, with the
`human|agent` actor axis derived server-side from the token — never caller-asserted across a network.

### 3.1 Async-ification

Do **not** change `createCore` itself. Follow the existing `DispatcherCore` pattern
(`packages/dispatcher/src/types.ts`) — per-consumer interface slices, flipped to `Promise`-returning
signatures (a sync core satisfies them trivially when consumers `await`):

- `McpCore` (new, `packages/mcp/src/types.ts`) — tool handlers are already async; awaiting is mechanical.
- `DispatcherCore` / `ReviewerCore` / `WatcherCore` — flip signatures, async-ify the tick loops.

### 3.2 Server side: agent-ops routes

New `packages/web/server/routes/agentOps.ts`, mounted in `app.ts` under the existing
`authMiddleware` guard. Explicit REST (not generic RPC) so per-route authz stays a static, auditable
table:

| Route | Core op | Principal |
|---|---|---|
| `POST /api/agent/claim` | `claimNextTask` | service only |
| `POST /api/agent/tasks/:key/submit` | `submitResult` | service only |
| `POST /api/agent/tasks/:key/progress` | `reportProgress` | service |
| `POST /api/agent/tasks/:key/comments` | `addComment(actor:'agent')` | service |
| `POST /api/agent/tasks/:key/status` | `updateStatus(actor:'agent')` | service |
| `POST /api/agent/tasks/:key/transcript` (append) / `PUT` (save) | `appendTranscript` / `saveTranscript` | service |
| `POST /api/agent/tasks/:key/metrics` | `addTaskMetrics` | service |
| `POST /api/agent/tasks/:key/session/touch` / `end` | `touchAgentSession` / `endAgentSession` | service |
| `POST /api/agent/tasks/:key/release-claim` | new `releaseClaim` (see 3.3) | service (supervisor) |
| `GET /api/agent/workspaces/:name/git-auth` | `resolveGitAuth` | service only — **secret**; audit each read to activity |
| `GET /api/agent/workspaces/:name/pat` | `getWorkspacePat` | service only (watcher) — same |
| `GET /api/agent/prompts/:key?workspace=` | `resolveAgentPrompt` | service |
| `POST /api/agent/supervisors/heartbeat` | `recordSupervisorHeartbeat` | service |
| `GET /api/agent/live-agents` | `listLiveAgents` | service |
| `POST /api/agent/tasks/:key/delivery/{begin,check,complete,fail}` | delivery ops | service (watcher) |

Reads (`listTasks`, `getTask`, `listWorkspaces`) reuse the existing `/api/tasks` / `/api/workspaces`
routes — already behind the guard and served to service tokens.

**The #31 actor rule, enforced in one place** (`packages/web/server/auth.ts`):
`Principal.kind === 'service'` ⇒ core calls run with `actor: 'agent'`; `kind === 'user'` ⇒
`'human'`. Agent-ops routes reject `user`/`anon`; human lifecycle routes (approve/reopen/…) reject
`service`.

### 3.3 The reaper wrinkle

The stale-claim reaper's release is the `{ in_progress → queued, by: 'human' }` edge — a service
token cannot legally assert it once actors are token-derived. Add a dedicated server-side
`releaseClaim` core op (system action, stamped `system-reap` in activity), exposed only on the
release-claim route for supervisor service tokens. Do **not** add an agent `in_progress → queued`
transition — that would let any worker un-claim anyone.

### 3.4 Client side: `createHttpCore`

`createHttpCore(baseUrl, token)` (`packages/core/src/httpCore.ts`, or a tiny `core-http` package if
keeping `node:sqlite` out of remote bundles matters): `fetch` + schema-parse per op,
`Authorization: Bearer`. `packages/mcp/src/index.ts` branches: `AGENTFACTORY_BOARD_URL` +
`AGENTFACTORY_TOKEN` set ⇒ HTTP core; else `AGENTFACTORY_DB` as today. `buildServer` is untouched
beyond the slice type.

**Acceptance gate:** run the MCP/dispatcher test suites against both backends — a real `Core` and an
`httpCore` pointed at an in-process `buildApp(core)` (same-suite-two-backends contract test).

**Migrations:** none (tokens shipped in #9). **Unblocks:** everything below. **Risks:** async ripple
through four packages (mitigate: slices first, mechanical awaits after); secret-bearing routes
(service-only + audit rows); claim atomicity becomes trivially safe (one process does
`BEGIN IMMEDIATE`).

### 3.5 The HTTP cut per consumer (verified against actual usage)

| Consumer | Ops over HTTP |
|---|---|
| Worker MCP session (`McpCore`) | `claimNextTask`, `getTask`, `listTasks`, `createTask`, `addComment`, `reportProgress`, `updateStatus`, `submitResult`, `resolveGitAuth`, `touchAgentSession`/`endAgentSession` |
| Remote dispatcher (`DispatcherCore`, all 15) | `listTasks`, `getTask`, `listWorkspaces`, `resolveGitAuth`, `resolveAgentPrompt`, `updateStatus`, `addComment`, `addTaskMetrics`, `touchAgentSession`, `endAgentSession`, `listLiveAgents`, `recordSupervisorHeartbeat`, `appendTranscript`, `saveTranscript` + new `releaseClaim` |
| Remote reviewer (`ReviewerCore`) | `listWorkspaces`, `listTasks`, `getTask`, `resolveAgentPrompt`, `addComment`, `recordSupervisorHeartbeat` (+ `resolveGitAuth` for its local clone of the diff) |
| Remote watcher (`WatcherCore`) | `listWorkspaces`, `listTasks`, `getTask`, `recordSupervisorHeartbeat`, `beginDelivery`, `recordDeliveryCheck`, `completeDelivery`, `failDelivery`, `getWorkspacePat` |

**Polling vs SSE:** keep the 15 s poll for all supervisors — simple, idempotent, survives
disconnects. The existing `/events` SSE (already token-capable via `?access_token=`) becomes an
optional wake-up optimization (Phase 5 #7).

---

## 4. Phase 2 — Remote dispatcher on own machines (zero crabbox) — **M**

**Goal.** Run the existing dispatcher on a spare machine pointed at the board's URL; its workers
claim/submit over HTTP. Verified: the dispatcher *loop* transfers unmodified; three deltas sit
outside it:

1. **Composition root** (`packages/dispatcher/src/index.ts` / `config.ts`): config gains
   `board: { url, token }` XOR `db:` — construct `createHttpCore` instead of `openCore`.
2. **`workspace.repoPath` is board-central but consumed as a local cwd.** The remote machine needs
   its own clone: add `repoPathOverrides: { [workspace]: localPath }` to the dispatcher config;
   `resolveGitAuth` over HTTP supplies the PAT for clone/fetch.
3. **Per-session MCP config** (`writeMcp`) injects `AGENTFACTORY_BOARD_URL`/`AGENTFACTORY_TOKEN`
   instead of the DB path.

Everything else transfers as-is: protocol worktree/push steps run on any machine with a real clone;
`checkSubmission` runs inside the worker's MCP against the *worker's* clone; the board's diff
fetches origin on the *board's* clone; transcript tail reads the worker-local JSONL and ships chunks
via the append route; OTel already posts to a URL.

**Also in this phase (strongly recommended):** flip the *local* dispatcher, reviewer, and watcher to
`httpCore` against `http://localhost` before going remote — perfect validation environment, and it
permanently ends N-writers-on-one-SQLite-file (`SQLITE_BUSY` under load).

**Risks:** board reachability (Phase 5 #2 — tailscale); a service token in plaintext in the worker
machine's config (accepted for a trusted team); WAN tick latency (dwarfed by the poll interval).

---

## 5. Phase 3 — Roles + reviewer assignment + token UI (trusted-team-lite) — **M**

*Independent of Phase 2 (different packages) — run in parallel. Phase 3 must land before the second
human gets a token; Phase 2 before the second machine.*

**Migration #23** (after task dependencies in migration #21 and its #22 reconciliation):

- `app_user.role TEXT NOT NULL DEFAULT 'contributor' CHECK (role IN ('admin','reviewer','contributor'))`;
  backfill existing rows to `'admin'`.
- `task.reviewer_user_id INTEGER NULL REFERENCES app_user(id)`.
- `api_token.expires_at TEXT NULL` (+ stamp `last_used_at` in `authenticateToken`).

**One enforcement chokepoint:** `requireRole(...roles)` middleware in `packages/web/server/auth.ts`
(Principal gains a `role` field), with the route→role gate as a single exported constant:

| Action | Minimum role |
|---|---|
| workspace create/update, PAT write, agent prompts, token/user management | admin |
| approve / request-changes / pr-reviewed / force-complete / reopen / release-claim | reviewer |
| create/edit/queue/comment/attachments, release own claim, own tokens | contributor |
| `AUTH_MODE=none` anon | acts as admin (preserves today's local UX) |
| service principals | agent-ops surface only (+ task create/list/comment for producer bridges) |

**Reviewer assignment (race prevention):** a "Start review" action claims atomically
(`UPDATE task SET reviewer_user_id = ? WHERE key = ? AND reviewer_user_id IS NULL` — the same shape
as `claimNextTask`). Approve/request-changes require assignee-or-admin; unassigned `in_review` tasks
are the shared pool. UI: assignee chip, "My reviews" filter, admin reassign.

**Token management UI:** settings modal — list (label, role, created, last-used, expires), mint
(secret shown once), revoke. Routes `GET/POST/DELETE /api/auth/tokens` (self-serve own; admin for
service/others'). `npm run token` stays as the lockout-proof bootstrap.

**Deliberately absent:** tenancy, per-workspace ACLs, groups, OIDC.

---

## 6. Phase 4 — crabbox execution profile for cloud boxes (prototype + decision gate) — **M**

**Where it plugs in:** `deps.spawn` (`SpawnFn`, `packages/dispatcher/src/types.ts`) — crabbox
replaces the local child-process layer and *nothing else*. New
`packages/dispatcher/src/crabboxSpawn.ts` returns a `SpawnedChild` wrapping a local
`crabbox run --` child; crabbox's CLI streams remote stdio, so the existing pipe/log/metrics
machinery works largely unchanged. Config: `executionProfile: 'local' | 'crabbox'` per
workspace/dispatcher (+ provider/pool options).

**Per-task flow:**

1. **Lease** — warm pool (`crabbox warmup`) for latency or fresh lease per task (matches
   one-session-per-task); `--id af-<taskKey>` for traceability; idle auto-release as orphan backstop.
2. **Provision** — do **not** rsync a local checkout (the dispatcher host may not have one): clone
   *in the box* using the deploy token from `resolveGitAuth`; hydrate MCP config + Anthropic key via
   crabbox file placement. MCP points at `AGENTFACTORY_BOARD_URL` + a service token — the worker in
   the box claims/submits over HTTP exactly like a Phase 2 worker (identical board surface, by design).
3. **Run** — the same `claude -p` argv the local spawn builds (`--mcp-config`, `--session-id`,
   stage args, permission mode).
4. **Transcript** — the local tail can't reach the box's filesystem: either run with
   `--output-format stream-json` and feed stdout into `appendTranscript`, or an in-box Stop-hook
   POSTs the full JSONL to the `PUT` transcript route. Pick during the prototype.
5. **Kill/timeout/reap** — `child.kill()` maps to crabbox stop/release (also fixes the Windows
   `.cmd`-shim process-tree kill gap for these sessions).

**Free from crabbox:** 20+ providers, warm pools, spend caps + per-user usage, evidence capture,
coordinator-held provider creds. **Still ours:** the profile plumbing, in-box bootstrap
(git + Node + claude in the image/warmup init), task↔lease lifecycle mapping, the transcript path.

**Go/no-go exit criteria:**

1. One implementation-stage task end-to-end on one cloud box (E2B or a Hetzner static-SSH box):
   claim → clone → edit → push → `submit_result` → in_review, with transcript, metrics, and OTel
   tokens visible on the board.
2. Timeout/kill releases the box and the claim reaper recovers the task.
3. Measured: lease-to-first-token latency warm vs cold; cost per task.
4. Zero board-side changes needed beyond Phase 1–2 surfaces (proves the abstraction held).
5. Bootstrap friction budget: if in-box hydration + auth fights back for more than ~a week, fall back.

**Native fallback:** (a) own machines never need this — Phase 2 covers them; (b) a plain `sshSpawn`
`SpawnFn` (S-sized, no coordinator) for hosts without a dispatcher; (c) the
[ACA Sandboxes design](./2026-07-02-remote-execution-aca-sandboxes-design.md) when the preview
opens — same seam, nothing wasted.

---

## 7. Phase 5 — Supporting features, ranked by value/effort

| # | Feature | What/where | Size |
|---|---|---|---|
| 1 | **AUTH_MODE safety flip** | Refuse to bind a non-loopback interface with `mode:'none'` (`packages/web/server/index.ts`); document `token` as the default for any exposed deployment. | S |
| 2 | **Board reachability guidance** | Docs: tailscale recommended (board stays private, workers join the tailnet; `/events?access_token=` already works) vs cloudflared. No code. | S |
| 3 | **Worker fleet visibility** | Migration #24: `host`/`profile` on `agent_session` + supervisor heartbeats (`os.hostname()`, execution profile) → "which machine ran what" in Agents/Supervisors views. | S |
| 4 | **Token expiry + last-used** | Ships with migration #23; enforcement in `authenticateToken`. | S |
| 5 | **Queue routing / capability tags** | `task.pool` (or workspace default) + `ClaimOptions.pool` in `claimNextTask` + dispatcher `pools: [...]` — pin heavy tasks to beefy machines, cloud-only workspaces to crabbox. | M |
| 6 | **Secrets hardening** | AES-GCM-encrypt workspace PATs at rest with a key from `AGENTFACTORY_SECRET_KEY` (currently plaintext in SQLite); write-only API stays. Not a vault. | M |
| 7 | **SSE wake for remote dispatchers** | Subscribe to `/events` to cut claim latency below the poll; poll stays as fallback. | S |
| 8 | **Concurrent-review presence** | "X is viewing" via SSE; mostly obviated by reviewer assignment — do last. | S |

---

## 8. Explicitly parked

- **Postgres** — SQLite behind a single-writer web API serves a handful of users indefinitely;
  revisit only if the web tier ever needs more than one node.
- **OIDC** — the stub stays stubbed; bearer tokens suffice for a trusted team.
- **Multi-tenancy / orgs** — one team, one board; tenancy touches every table for zero current users.
- **Vault/KMS** — env-key AES-GCM (Phase 5 #6) is proportionate; a vault is standing ops burden.
- **Per-workspace ACLs** — the three-role gate is enough until a concrete need appears.
- **Own sandbox orchestration** (Firecracker/K8s) — exactly the layer crabbox/ACA sells; never build it.
- **Board-side worker filesystem access / patch upload** — the diff is origin-based; keep it that way.

---

## 9. Dependency graph

```
Phase 1 (HTTP agent ops + #31) ──► Phase 2 (remote dispatcher, own machines)
        │                                   │
        │                                   └──► Phase 4 (crabbox prototype → gate → commit or SSH/ACA)
        └──► Phase 3 (roles + reviewer assignment)   [parallel with 2; land before inviting humans]

Phase 5 items slot in opportunistically; #1/#2 ship with whichever of 2/3 first exposes the board.
```
