# AgentFactory — Diff view (review a task's code changes on the board)

**Date:** 2026-06-11
**Status:** Implemented (2026-06-11)
**Grows from:** [2026-06-09 task board design](2026-06-09-agent-loop-task-board-design.md) —
the board records *references* to agent work (branch/worktree/PR links) but cannot show the
work itself; and [2026-06-11 claim recovery](2026-06-11-claim-recovery-design.md), which made
runs visible. This makes the *result* visible.

## Problem

The review step is blind. When a worker submits a result, the human gets a prose summary and
a list of links — to act on Approve / Request changes they must leave the board, open a
terminal or GitHub, and diff the branch by hand. The board is the loop's review surface in
every other respect (spec, acceptance criteria, activity, feedback); the one thing it cannot
answer is *what did the agent actually change?*

The raw material is already recorded: workers follow the documented convention of working on
branch `task/<key>` and submitting a `branch`-kind link, and every task's workspace knows its
local `repoPath`. Nothing reads it.

## Goals

- An `in_review` (or any branch-linked) task shows its **diff against the default branch**
  inline on the board: per-file, line-level, additions/deletions colored.
- A compact **stat** (files changed, +adds −dels) in the detail panel; the full diff in a
  near-full-screen modal.
- The diff is **live** — computed from the workspace repo on demand, never stored.
- Zero new dependencies; zero DB/MCP/schema changes.

## Non-Goals (deferred)

- Syntax highlighting, side-by-side mode, intra-line word diffs.
- Stored patches or any diff persistence — the repo is the source of truth.
- Caching, streaming, pagination of huge diffs (a size cap with a clear error instead).
- Commenting on diff lines; review comments stay in the activity thread.
- PR/remote-host integration (GitHub API etc.) — local git only.
- Diffing uncommitted worktree changes — review happens after `submit_result`, when the
  branch is final. (Corollary: commits added to a branch *without* a board write won't
  auto-refresh an open panel; acceptable for the same reason.)

## Decisions

| Decision | Choice | Why |
|----------|--------|-----|
| Diff source | Web server runs read-only `git diff` on demand (new endpoint `GET /api/tasks/:key/diff`) | Single-user local tool; workspace repos are local paths. Always current, no DB bloat, no agent/MCP changes. The board stays a visualization layer — this is read-only inspection, not git orchestration. |
| Where git runs | New `packages/web/server/git.ts`; async `execFile` (never a shell) | Core is synchronous pure-domain over SQLite; spawning processes there would break its character. Only the web server consumes diffs. |
| Branch identification | Last `branch`-kind link's **label** | MCP `LinkSchema` forces `url` to be a URL, so the documented `task/<key>` ref can only live in the label. Links are ordered by id; last = most recent submission (re-submissions win). |
| Diff base | `<default>...<branch>` (merge-base, three-dot) | Commits landing on main after the branch point must not pollute the review diff. |
| Default branch resolution | `origin/HEAD` → local `main` → local `master` → error | Convention-first, no config. |
| Untrusted input | Branch labels are agent-submitted: allowlist regex (`^(?!-)(?!.*\.\.)[\w./-]+$`), refs passed after `--end-of-options`, trailing `--`, `existsSync` precheck on repoPath, `GIT_OPTIONAL_LOCKS=0` | No option injection, no revision-range tricks, server stays strictly read-only on the repo. |
| Response shape | JSON `{ branch, baseRef, diff }` | Matches the JSON-only client `req` helper; modal header needs the refs. |
| Rendering | Hand-rolled unified-diff parser + viewer, zero deps | A parser is ~100 lines; the project has no rendering deps and a bespoke design system. |
| UI placement | "Changes" section in DetailPanel (stat + button) → full-screen modal | Diffs need width; the drawer is 460px. Reuses the `.af-overlay`/modal pattern. |
| Fetch strategy | Fetch once when the Changes section mounts, keyed on `task.updatedAt`; modal reuses the data | The stat needs the diff anyway. `updatedAt` changes exactly when this task changes (SSE → task refetch → diff refetch), never for other tasks. |
| Stats | Client computes from the parsed diff | It parses anyway; a second `--numstat` git call buys nothing. |

## Error matrix

| Case | Error | HTTP |
|---|---|---|
| Unknown task key | core `NotFoundError` | 404 |
| No `branch`-kind link on task | core `NotFoundError` | 404 |
| Branch not in repo | core `NotFoundError` | 404 |
| Label fails the ref allowlist | core `ValidationError` | 400 |
| repoPath missing / not a git repo / no default branch / git not installed / diff exceeds 32 MB cap | **`GitError`** (new) | **422** |
| Branch even with base | — (`diff: ''`) | 200 |

Companion fix: `mapError` responses become JSON `{ message }` (via the `HTTPException` `res`
option) — the client already tries `res.json().message` and today gets only a bare status
code. All endpoints gain readable errors; no client change.

## Server surface

- `packages/web/server/git.ts`: `resolveBaseRef(repoPath)`, `branchDiff(repoPath, branch)`,
  `GitError`. Invocations: `rev-parse --git-dir` (repo check) → base resolution →
  `rev-parse --verify --quiet --end-of-options <branch>` (existence) →
  `git -c core.quotepath=false diff --no-color --no-ext-diff --find-renames
  --end-of-options <base>...<branch> --`.
- `GET /api/tasks/:key/diff` (async handler in `routes/tasks.ts`) → `{ branch, baseRef, diff }`.

## Web client surface

- `diff.ts` — `parseUnifiedDiff(text)` → files (status modified/added/deleted/renamed,
  binary flag, hunks, line numbers, per-file and total ±counts).
- `DiffView.tsx` — stat line + per-file collapsible sections; files over 300 rendered lines
  start collapsed; binary files show a notice. Dark tokens only (`--bg-deep` well, `--green`
  adds, `--st-blocked` dels, Plex Mono).
- `DiffModal.tsx` — full-screen overlay (`min(1200px, 96vw) × 92vh`), header
  `branch ← baseRef`, Escape/scrim/✕ close.
- `Changes.tsx` — DetailPanel section: owns fetch + parse, renders stat + "View diff",
  error and "No changes vs base" states.
- `api.ts` — `getDiff(key)` returning `TaskDiff`.

## Acceptance criteria (feature-level)

1. A task with a branch link whose branch exists shows a Changes stat in the detail panel
   and a modal with the correct per-file, line-numbered, colored diff; commits on main
   after the branch point do not appear.
2. Re-submission (new branch link and/or new commits + board write) refreshes the diff via
   SSE without reopening the panel; the last branch link wins.
3. Tasks without a branch link show no Changes section; even branches show "No changes";
   missing branch/repo/git problems surface as readable messages in the panel (404/422 JSON).
4. Hostile link labels (`--output=…`, `a..b`, leading `-`) are rejected with 400 and never
   reach a git process.
5. Zero new dependencies; core/mcp packages and the DB schema are untouched; full suite
   green.
