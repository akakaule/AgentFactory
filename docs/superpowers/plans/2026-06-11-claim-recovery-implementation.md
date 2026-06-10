# Claim recovery — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-claim-recovery-design.md](../specs/2026-06-11-claim-recovery-design.md)
**Status:** Implemented (2026-06-11)

Four phases, dependency-ordered (`core → mcp → web client → e2e/docs`). TDD per task:
failing test first, implement, package suite green, full `npm test` at phase ends.

---

## Phase 1 — core

### 1.1 Migration #3: claim columns

- **Files:** `packages/core/src/schema.ts` (`MIGRATION_3_SQL`: two nullable ADD COLUMNs),
  `migrate.ts` (append to `MIGRATIONS`).
- **Tests** (`test/claim.test.ts`, new): fresh DB → `user_version = 3`, columns exist and
  are `NULL`; simulated v2 DB with a task migrates in place; re-run is a no-op.
  Touch-up: `migrate.test.ts` + `workspace.test.ts` assert `user_version` 2 → 3.

### 1.2 Claim metadata on claim; payload fields

- **Files:** `types.ts` (`Task.claimedBy/claimedAt: string | null`),
  `repo/tasks.ts` (`TaskRow` + `toTask` mapping — `SELECT task.*` already returns the
  new columns), `ops/claimNextTask.ts` (signature →
  `claimNextTask(db, opts: { workspace?; claimedBy? } = {}, now)`; UPDATE sets
  `claimed_by`/`claimed_at`; the row re-spread into `toDetail` carries them),
  `index.ts` (bound `claimNextTask(opts?)`).
- **Call-site sweep:** `claimNextTask(db, 'a')` in `workspace.test.ts` →
  `claimNextTask(db, { workspace: 'a' })`; `(db, undefined, now)` sites still type-check
  (opts defaults). Bound callers: mcp `getNextTask`, web `e2e.workspaces.test.ts`
  (`{ workspace: 'repo-a' }`), plain `core.claimNextTask()` sites unchanged.
- **Tests:** claim with `claimedBy` records both fields (payload + DB); claim without
  label records `claimed_at` only; unclaimed task lists `null`s.

### 1.3 Release transition + clear-on-queued

- **Files:** `transitions.ts` (add `{ from: 'in_progress', to: 'queued', by: 'human' }`),
  `repo/tasks.ts` (`setStatus` clears `claimed_by/claimed_at` when the new status is
  `'queued'`).
- **Tests:** human releases in_progress → queued via `updateStatus`, claim fields
  cleared, activity row written; agent attempting it → `InvalidTransitionError`;
  request-changes (in_review → queued) and blocked → queued also clear; re-claim after
  release overwrites metadata and the prior activity/feedback is visible to the new
  claimant; `transitions.test.ts` count assertions updated if they enumerate rules.

**Phase gate:** core suite green; full `npm test` (payload shape changed — fix fallout
here); `tsc -b` clean.

---

## Phase 2 — mcp

### 2.1 Worker label env → claimedBy

- **Files:** `src/server.ts` (`ServerOptions.workerLabel?`), `src/index.ts`
  (`AGENTFACTORY_WORKER ?? AGENTFACTORY_WORKSPACE` → `workerLabel`; stderr log includes
  it), `tools/getNextTask.ts` (`core.claimNextTask({ workspace, claimedBy: opts.workerLabel })`).
- **Tests** (`tools.test.ts` + harness opts): claimed payload carries
  `claimedBy === workerLabel`; falls back to the workspace pin when only that is set;
  null when neither.

### 2.2 README

- **Files:** `packages/mcp/README.md` — `AGENTFACTORY_WORKER` in the workspaces/env
  section; note that a stranded claim is released from the web UI.

**Phase gate:** mcp suite green.

---

## Phase 3 — web client (server needs no changes)

### 3.1 Release path server test (expected no-op change)

- **Files:** `test/server/tasks.test.ts` — drive a task to in_progress, POST
  `{ status: 'queued' }` → 200, claim fields null in response; same POST as the
  underlying core actor `agent` is impossible via API (route hardcodes `'human'`) —
  assert MCP-side rejection is covered in core tests instead.

### 3.2 DetailPanel: claimant line + Release claim

- **Files:** `components/DetailPanel.tsx` — for `status === 'in_progress'`: "Claimed by
  *label* · *age*" (label omitted when null; age from `claimedAt`) + **Release claim**
  button → `api.setStatus(task.key, 'queued')` (exists). Small `timeAgo` helper.
- **Tests** (`DetailPanel.test.tsx`): in_progress fixture with claim fields renders line
  + button; clicking calls `setStatus(key, 'queued')`; backlog/in_review fixtures show
  neither.

### 3.3 Board claim chip

- **Files:** `components/TaskRow.tsx` — muted chip with `claimedBy ?? 'claimed'` +
  age on `in_progress` rows (both views get it via TaskRow).
- **Tests:** GroupedList fixture with a claimed in_progress task shows the chip; an
  unclaimed backlog task doesn't.

**Phase gate:** web suite green.

---

## Phase 4 — e2e + docs

### 4.1 Crashed-worker e2e

- **Files:** extend `test/server/e2e.workspaces.test.ts` or sibling: worker claims,
  "dies" (no further calls), human releases via HTTP, a second worker re-claims and the
  detail carries the full prior activity; claim metadata reflects the new worker.

### 4.2 Docs

- **Files:** root `README.md` (one paragraph: stale claims + release), spec/plan status →
  Implemented.

**Final gate:** full `npm test` green; `npm run build` clean.

---

## Risks / watch-outs

- **`Task` payload widens again** — every list/detail consumer compiles against it; the
  client re-exports types from core so no mirroring, but strict-equality test fixtures
  need the two new fields (same drill as workspaces).
- **`claimNextTask` signature change** is the only breaking surface — sweep call sites in
  the same commit (Phase 1.2 list).
- Estimated touch: ~10 source files + ~7 test files across 3 packages; no dependency
  additions.
