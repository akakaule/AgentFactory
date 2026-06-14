# AgentFactory — Expansion roadmap: local + mobile, then multi-tenant cloud team

**Date:** 2026-06-13 (approved) · **Last updated:** 2026-06-14
**Status:** Phases 1–2 **shipped** (local + mobile companion) on local branch
`feat/phase1-auth-foundation` (not yet pushed). Phases 3–8 (cloud team product) are
**parked — to be resumed later.**

> Companion docs: [mobile-remote-access.md](mobile-remote-access.md) (Tailscale runbook for the
> shipped phone access). The original approved planning notes live outside the repo at
> `~/.claude/plans/current-this-tool-is-cozy-pond.md`; this file is the canonical, committed copy.

## Why this exists

Two expansion directions were on the table:

- **A — Cloud team product:** multiple humans collaborating across one or many customer projects,
  with the DB + web app hosted in Azure.
- **B — Local + mobile:** keep the dashboard running locally, but follow status, do reviews, and
  submit tasks from a phone.

They are **not two products — they are two depths of one evolution that share a single
foundation.** The board has destructive actions (approve, request-changes, reopen, delete, queue
work that runs agents) and originally had **zero authentication**. The moment the board is reachable
beyond `localhost` — via an Azure URL *or* a phone tunnel — it needs real user identity. So both
options require the same first step: **auth + user attribution.** B is the minimal increment of
that foundation; A is the full build on top of it.

## The one architectural fact everything hangs on

The board, DB, REST API, SSE stream, and AI-review loop are **already portable** — the server is
stateless, `Core` is a clean DB abstraction, and the reviewer loop already runs purely over HTTP.
**The only thing fundamentally nailed to a workstation is the implementation-stage agent** (git
worktree, push to origin, local `claude`). And the pipeline *already* separates the stages that
need git from the ones that don't: `packages/mcp/src/protocol.ts` returns `setup: []` for
`description`/`plan` (pure-text deliverables) and only emits a worktree/branch for `implementation`.
**That stage boundary is the seam for hybrid cloud execution** — which is why the eventual cloud
move is an evolution, not a rewrite.

## Decisions locked (with the user)

- **Hybrid cloud execution:** doc stages (description/plan) run as a pure cloud worker calling the
  Claude API; only the implementation stage runs on a self-hosted runner that holds the repo.
- **Tenancy = multi-customer + RBAC:** a real customer → project → workspace(repo) hierarchy, users
  scoped to their customers, data isolation, roles (admin / reviewer / contributor).
- **Phased mobile → cloud:** ship the local+mobile companion first; layer the cloud team product on
  the same auth foundation.
- **Identity:** Entra ID (Azure AD) via OIDC for the cloud phase; a simpler token mode ships first.
- **Data tier:** SQLite → Azure Database for PostgreSQL via an async `Db` port (**headline risk** —
  the sync→async ripple).

## Phases at a glance

| Phase | Scope | Status |
|------|-------|--------|
| **1** | User + auth (`token` mode, OIDC-ready) + `actor_user_id` attribution | ✅ **done** |
| **2** | Responsive PWA + client token sign-in + secure remote (Tailscale) | ✅ **done** |
| **3** | Multi-customer + project + RBAC (on the existing SQLite schema) | ⏸ parked |
| **4** | Async `Db` port — pure refactor, SQLite adapter stays green (**gating risk**) | ⏸ parked |
| **5** | Postgres adapter + migration port; attachments → Blob; SSE → LISTEN/NOTIFY | ⏸ parked |
| **6** | Cloud doc-worker (description-first) as a Container Apps Job + `stages` claim filter | ⏸ parked |
| **7** | Self-hosted runner bridge (`createHttpCore`, `/claim`+`/submit`+heartbeat) + diff-source swap | ⏸ parked |
| **8** | Azure hardening (Key Vault, managed + workload identity, KEDA autoscale) | ⏸ parked |

Phases 1–2 = the **local + mobile companion**. Phases 3–8 = the **cloud team product** on the same
base. Phase 3 (RBAC) is still synchronous and can land on SQLite *before* any cloud cutover.

---

## Phases 1–2 — DONE (the local + mobile companion)

Branch `feat/phase1-auth-foundation` (3 commits, local only): `977f3cd` core attribution,
`827a763` API auth, `0525a57` mobile PWA. Full test suite green; `tsc -b` clean; client build emits
the PWA assets. **All additions are opt-in — default `AUTH_MODE=none` keeps local behavior
identical.**

### Phase 1 — auth + attribution
- **Migration #9** (`packages/core/src/schema.ts`, `migrate.ts`): `app_user` (named to dodge the
  SQL-reserved `user` / Postgres quoting), `api_token` (sha256-hashed bearer, raw shown once), and a
  nullable `activity.actor_user_id`; seeds a system user at id=1 (fixed-epoch, invisible to
  `getVersion()`).
- **Attribution:** an optional `actorUserId` threads through `addComment` / `updateStatus` /
  `reviewApprove` / `reviewRequestChanges` and the shared `applyApproval` down to the single
  `appendActivity` write; `recentActivity` LEFT JOINs `app_user` for the display name. The binary
  `actor` enum is untouched (orthogonal + nullable → the agent/MCP path stays NULL).
- **Auth middleware** (`packages/web/server/auth.ts`, `app.ts`): keyed on `AUTH_MODE` — `none`
  (default, anon, never 401s) or `token` (bearer). `/api/*` and `/events` are guarded; the SPA shell
  and `/auth/whoami` stay public; `EventSource` passes its token via `?access_token=`. `oidc` throws
  a clear "Phase 3" error until built. `npm run token` mints tokens.

### Phase 2 — responsive PWA + remote
- **Responsive** (`board.css`, `App.tsx`): a `≤768px` breakpoint turns the 6-column board into a
  scroll-snapping one-column carousel, wraps the header, and adds a bottom tab bar (reuses the `view`
  state, CSS-hidden on desktop). Full-screen diff, 44px touch targets. Desktop layout unchanged.
- **Touch moves:** no new logic — the drawer already has a button for every legal human move, so
  tap-a-card → drawer is the mobile flow (drag-drop was always desktop-only).
- **Client token sign-in** (`api.ts`, `useEventStream.ts`, `components/TokenGate.tsx`): the SPA sends
  the stored bearer on every request and on the SSE URL; a 401 surfaces a paste-token gate. Inert in
  none-mode.
- **PWA** (`client/public/{manifest.webmanifest,sw.js,icon.svg}`, `main.tsx`, `index.html`):
  installable standalone app + a **prod-only network-first** service worker (network-first so it
  never serves a stale build) with an offline shell. Deliberately *no* `vite-plugin-pwa` (no new
  dependency).
- **Attribution surfaced:** the activity timeline shows the human's name ("Alvin approved").

### How to run / verify the shipped phases
```sh
AUTH_MODE=token npm run web
npm run token -- --label "my phone" --email you@example.com --name "You"
# reach it from a phone over Tailscale and paste the token — see docs/mobile-remote-access.md
```

---

## Phases 3–8 — PARKED (the cloud team product)

Design captured here so the work can resume cleanly. Not started.

### Phase 3 — multi-tenant data model + RBAC (still SQLite)
Hierarchy **customer → project → workspace(repo) → task**, plus `membership`. Additive migrations in
the established pattern (nullable/defaulted, version-bumped, seed a default customer/project at id=1).
**Denormalize `task.customer_id`** so tenant scoping is a single `WHERE task.customer_id IN (…)`
predicate, not a 3-table JOIN. Data isolation lives at the one read chokepoint —
`SELECT_TASK` + `listRows` in `packages/core/src/repo/tasks.ts` — plus a post-fetch
`assertTenantAccess` guard returning `NotFound` (not 403 — don't leak cross-tenant existence). RBAC
enforced at the route boundary (`server/routes/tasks.ts`) via a `requireRole` helper; the agent/MCP
path keeps its `Actor`-enum transition gate (no role gate). OIDC (Entra) wired here.

### Phase 4 — async `Db` port (the gating risk)
`node:sqlite` is synchronous; `pg` is async. Introduce a thin async `Db` port
(`query`/`queryOne`/`exec`/`transaction`) at `packages/core/src/db.ts` + `transaction.ts`, with a
`?`→`$1` placeholder shim **inside** the pg adapter so `repo/*` diffs stay method-name-only. Keep a
SQLite adapter for local dev/tests (dual-adapter) — do this as a pure refactor with SQLite still
green to prove parity *before* Postgres enters. `BEGIN IMMEDIATE` → `SELECT … FOR UPDATE SKIP LOCKED`
on the claim.

### Phase 5 — Postgres + Blob + SSE fan-out
Postgres adapter + port the migrations (behind a `schema_migrations` table + `pg_advisory_xact_lock`).
Attachments move from SQLite BLOB to **Azure Blob Storage** behind a small `BlobStore` port. SSE
fan-out: replace per-instance version polling with Postgres `LISTEN/NOTIFY` (the signal is one
monotonic version string — no Redis), keeping the poll as a fallback so the client contract is
unchanged.

### Phase 6 — cloud doc-worker
A service that claims `description`/`plan` tasks and calls the **Claude API** directly (no CLI, no
filesystem) — reuses Core ops + the protocol's stage logic and the dispatcher's worker-prompt
branches. Hosted as an Azure **Container Apps Job** (KEDA queue-depth scaler, scale-to-zero). Add a
`stages?: Stage[]` filter to the claim (`claimNextTask` / `oldestQueuedRow`) to route doc stages to
the cloud worker and `implementation` to a runner. Ship **description** pure-cloud first; the plan
stage can stay on a runner until a git-host file-fetch path exists.

### Phase 7 — self-hosted runner + diff-source swap
Introduce **`createHttpCore(baseUrl, token)`** implementing the same `Core` interface over cloud REST
and hand it to the **unchanged** MCP `buildServer` (the tools never touch the DB → drop-in). The
dispatcher becomes the runner's implementation-only supervisor (add `stage:'implementation'` claim
filter; reuse spawn/reap/retry). Runner auth via a service token (same pattern the reviewer loop
uses), federating to Entra workload identity later; capability registration via
`POST /api/runners/heartbeat`. **git-diff-on-cloud:** the runner POSTs the computed patch on submit
(primary), git-host compare API as fallback; refactor `server/git.ts branchDiff` into a `DiffSource`
strategy. `checkSubmission` (the **AF-15 push-before-review contract**) stays on the runner — the
cloud never re-verifies.

### Phase 8 — Azure hardening
API+SPA on Container Apps, Postgres Flexible Server, Key Vault + managed identity for secrets
(Claude key, git/runner tokens), Entra for OIDC + workload identity, KEDA autoscale.

### Hybrid execution topology (target state)
```
Azure (multi-tenant control plane)
  Container App: Hono API + SPA  ──►  Azure DB for PostgreSQL  ◄── single source of truth
        │ createCore(pgPool)             ▲  LISTEN/NOTIFY (SSE fan-out)
        ▼                                │  Key Vault (Claude key, git/runner tokens)
  Container Apps Job (KEDA): doc-worker  │  Blob Storage (attachments)
     claims description/plan,            │
     calls the Claude API directly ──────┘
                    ▲ HTTPS + service token, capability heartbeat
                    │
  Self-hosted runner (customer trust boundary)
     holds repos + local git + local claude · IMPLEMENTATION only · POSTs diff on submit
```

---

## Critical files / seams (for when work resumes)

- `packages/core/src/schema.ts` + `migrate.ts` — new migrations (tenancy, `project_id`,
  `task.customer_id`); dialect tweaks for the Postgres port.
- `packages/core/src/repo/tasks.ts` — `SELECT_TASK` / `listRows` / `oldestQueuedRow`: the single
  tenant-scope chokepoint **and** the `stages` routing filter.
- `packages/core/src/db.ts` + `transaction.ts` — the adapter seam → async `Db` port (pg + SQLite).
  Heart of the sync→async ripple.
- `packages/web/server/git.ts` (+ `routes/tasks.ts` `/:key/diff`) — refactor to a `DiffSource`.
- `packages/mcp/src/server.ts` (+ `git.ts`) — host point for `createHttpCore`; `checkSubmission`
  stays on the runner (preserves AF-15).
- `packages/dispatcher/src/dispatcher.ts` — becomes the runner's implementation-only supervisor;
  model for the doc-worker's claim/submit/metrics loop.

## Risks (ranked)
1. **Sync→async Core port (Phase 4)** — widest blast radius. Mitigate with the `Db` port + shim; do
   it with SQLite still green so tests prove parity before Postgres.
2. **A read path bypasses tenant scoping → cross-customer leak.** Route all task reads through
   `SELECT_TASK`/`listRows` + `assertTenantAccess`; add a test that a scoped principal gets
   `NotFound` for another customer's key.
3. **git-diff / submit topology** (AF-15). Treat the POSTed patch as a cache; the host compare API
   can always reconstruct; verification stays on the runner.
4. **Cloud Claude API cost** (doc-worker per-token vs. CLI subscription). Stage-tier the model,
   prompt-cache the stable prefix, cap `max_tokens`, track exact usage in `task_metric`.
5. **Self-hosted runner executes agent-written code** — the customer's trust boundary (the reason
   implementation stays self-hosted). Least-privilege the runner token; the cloud never runs agent
   code.

## Resuming this work
1. Read this file + the project memory entry `team-cloud-expansion-roadmap`.
2. The shipped foundation is on `feat/phase1-auth-foundation` (decide push/PR first).
3. Start with **Phase 3** (multi-customer + RBAC) — it lands on SQLite and unblocks the rest; or
   jump to **Phase 4** (the async port) if the immediate goal is the Postgres/cloud cutover.
