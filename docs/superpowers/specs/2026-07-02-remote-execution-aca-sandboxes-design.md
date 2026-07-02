# Remote task execution — Azure Container Apps Sandboxes (design)

**Status: design only — nothing here is built.** Extracted from Part 6 of
`docs/superpowers/plans/2026-07-02-delivering-watcher.md` into its own document; the
delivering-watcher feature is independent and already shipped on its branch.
Related GitHub issues: #31 (authenticated lifecycle — hard prerequisite), #41 (sandbox
execution profiles), #42 (remote supervisor fleet). Builds on `docs/expansion-roadmap.md`
Phases 6–7 — treat that as the parent design, this doc as the ACA-specific concretization.

## Goal

Run implementation-stage agent sessions on machines other than the board's workstation —
specifically in [Azure Container Apps Sandboxes](https://learn.microsoft.com/en-us/azure/container-apps/sandboxes-overview)
(preview): hardware-isolated microVMs, sub-second start from prewarmed pools, OCI images as
root filesystems, suspend/resume snapshots, exec/file APIs, per-sandbox egress policies,
scale-to-zero pricing. The board stays the single source of truth; sandboxes are disposable
compute.

## What pins execution to one machine today

1. **Claim/submit is stdio-MCP + direct SQLite.** Every worker session's MCP server opens
   `agentfactory.db` via the filesystem (`AGENTFACTORY_DB`). There is no networked way to
   atomically claim (`get_next_task`) or submit (`submit_result`). This is THE blocker.
2. **The dispatcher spawns with `cwd = workspace.repoPath`** — a local git clone — and the
   claim protocol (`packages/mcp/src/protocol.ts`) emits local `git worktree add` /
   `git push -u origin` steps keyed off that path.
3. **Verification reads local git**: `checkSubmission` (branch on origin, worktree removed)
   and the web diff view (`branchDiff` from the merge-base) both `execFile git` against
   `repoPath`.

## Target architecture

### 1. `createHttpCore` — the networked board surface (prerequisite)

A `createHttpCore(baseUrl, token)` implementing the same `Core` interface over authenticated
REST, handed to the **unchanged** MCP `buildServer` — tools never touch the DB directly, so
this is a drop-in (`packages/mcp/src/server.ts` is the host point). Server side: new web
routes for the agent ops (claim / submit / comment / progress / transcript append),
authenticated with the **existing** `api_token` service tokens (`is_service`, on main since
migration #9). Claim atomicity stays server-side (`BEGIN IMMEDIATE` in one process), so
remote races resolve exactly like local ones.

**Hard gate — issue #31 first:** core's `actor: 'human' | 'agent'` axis is caller-asserted.
That honor system cannot cross a network boundary; every remote call must carry an
authenticated principal and a claim-bound token before any of this is exposed.

### 2. ACA sandbox spawn profile for the dispatcher

The dispatcher's spawn is already fully abstracted behind `deps.spawn` / `deps.resolveClaude`
(`packages/dispatcher/src/types.ts`) — a remote executor is a clean injection, not a rewrite:

- **Image**: a prebaked OCI disk image with git + Node + the claude CLI (+ codex for the
  reviewer later). Sandboxes are created/resumed via the ADC data plane
  (`management.azuredevcompute.io`), scoped to a sandbox group; resource tier M (1 CPU/2 GB)
  as default.
- **Per task**: create (or resume a snapshot of) a sandbox, exec the same `claude -p` argv the
  local spawn builds today, with `AGENTFACTORY_*` env pointing the in-sandbox MCP server at
  the HTTP core instead of a DB path.
- **Repo access**: the sandbox clones via the provider URL (a scoped deploy token/PAT mounted
  as a sandbox secret). Worktrees degenerate to plain clones — the protocol's
  worktree/`setup` steps generalize to a per-execution-profile `checkout` block computed at
  claim time (the `buildProtocol` seam already branches per stage; add a profile axis).
- **Egress policy**: allowlist the git host, `api.anthropic.com`, and the board URL — nothing
  else. This is the concrete mechanism behind issue #41's "container profile", and the
  profile actually used should be stamped into the claim activity as an attestation (#41).
- **Timeout/reap**: the dispatcher's kill becomes a sandbox stop/delete — which also fixes the
  documented Windows `.cmd`-shim process-tree kill gap for remote sessions.

### 3. What stays runner-side (unchanged contracts)

- **Push-before-review (AF-15)** holds: the sandbox pushes the feature branch to origin
  before `submit_result`; `checkSubmission` runs inside the sandbox against its clone.
- **Diff view** already computes from origin refs via merge-base — the board never needs the
  sandbox's filesystem. (Roadmap Phase 7's `DiffSource` strategy — runner POSTs the patch —
  is an optimization, not a prerequisite.)

### 4. What the delivering-watcher branch already did to keep this door open

- Origin-URL resolution is isolated in `core/src/remote.ts` (`resolveOriginUrl`) and
  injectable via `createCore(db, { resolveOrigin })` — swap for a stored
  `workspace.origin_url` column when repoPath stops meaning "local clone".
- The watcher is pure DB + REST (no local git) — it runs anywhere the DB (later: HTTP core)
  is reachable, and its delivery verification is exactly the post-merge half of the remote
  story.

## Sequencing

1. **#31 authenticated lifecycle** — claim-bound tokens, role-bearing principals.
2. **HTTP core surface** — `/api/core` agent ops + `createHttpCore`; dispatcher gains a
   `stage`/workspace claim filter so doc stages can go remote first (they carry no git at
   all — the cheapest proving ground, per roadmap Phase 6).
3. **ACA sandbox execution profile** — the spawn implementation above, implementation stage
   included; attestation stamping per #41.

**Do not start** before ACA Sandboxes exits its Entra-gated preview or its SDKs stabilize
(portal + CLI today; C#/Python SDKs "coming soon"; preview resources may need recreation).
Requires the `Container Apps SandboxGroup Data Owner` role and Entra ID accounts.

## Open questions

- Sandbox lifetime strategy: fresh sandbox per task (clean-room, matches the dispatcher's
  one-session-per-task rule) vs. suspend/resume snapshots per workspace (faster warm start,
  clone cache) — leaning fresh-per-task with a snapshot holding the preinstalled toolchain.
- Claude auth inside the sandbox: API key as sandbox secret vs. OAuth token exchange — API
  key is the only headless-safe option today.
- Cost telemetry: OTel export from inside the sandbox to the board's `/v1/logs` needs the
  board URL in the egress allowlist (already required for MCP-over-HTTP).
