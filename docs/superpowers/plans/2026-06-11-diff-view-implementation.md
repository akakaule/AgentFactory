# Diff view — Implementation Plan

**Date:** 2026-06-11
**Spec:** [2026-06-11-diff-view-design.md](../specs/2026-06-11-diff-view-design.md)
**Status:** Implemented (2026-06-11)

Six phases, dependency-ordered (`server git module → route → client parser → viewer →
panel integration → e2e/docs`). TDD per task: failing test first, implement, package suite
green, full `npm test` at phase ends. Everything lives in `packages/web`; no dependency
additions, no core/mcp/schema changes.

---

## Phase 1 — server git module

### 1.1 Git fixtures helper

- **Files:** `test/server/helpers/gitFixtures.ts` (new) — real temp repos via
  `execFileSync('git', …)` with identity/signing pinned per call
  (`-c user.email -c user.name -c commit.gpgsign=false`):
  `gitIn(dir, ...args)`, `initGitRepo(opts?: { defaultBranch? })` (mkdtemp + `init -b` +
  seed commit), `commitFile(dir, file, content, msg?)`,
  `addBranchWithChange(dir, branch, file, content)` (branch off, commit, switch back),
  `cleanupRepo(dir)`.

### 1.2 `git.ts`

- **Files:** `server/git.ts` (new) — `GitError`, `resolveBaseRef`, `branchDiff`; internal
  `runGit` via promisified `execFile` (`cwd`, 32 MB `maxBuffer`, `windowsHide`,
  `GIT_OPTIONAL_LOCKS=0`); `SAFE_REF` allowlist; `existsSync` precheck.
- **Tests** (`test/server/git.test.ts`, new): merge-base semantics (post-branch main commit
  excluded); base resolution order — local `main`, `master`-only repo, fake `origin/HEAD`
  (via `git update-ref` + `git symbolic-ref`) → `origin/<name>` wins; `GitError` for
  missing dir / non-repo dir / no resolvable base; `NotFoundError` for missing branch;
  `ValidationError` for hostile labels (`--output=x`, `a..b`, leading `-`) **without
  spawning**; empty diff for an even branch; rename detected (`--find-renames`).

**Phase gate:** git tests green; `tsc -b` clean.

---

## Phase 2 — route + error mapping

### 2.1 `GitError → 422` + JSON error bodies

- **Files:** `server/errors.ts` — add `GitError` mapping; switch all mappings to JSON
  `{ message }` bodies via the `HTTPException` `res` option.
- **Tests:** `test/server/errors.test.ts` — `GitError → 422`; body shape is JSON
  `{ message }` for each mapped class.

### 2.2 `GET /api/tasks/:key/diff`

- **Files:** `server/routes/tasks.ts` — async handler: `core.getTask` → last
  `branch`-kind link or `NotFoundError` → `branchDiff(task.repoPath, link.label)` →
  `{ branch, baseRef, diff }`.
- **Tests** (`test/server/diff.test.ts`, new; route-level via `app.request()` with a temp
  git repo as the workspace): happy path 200 with the committed change in `diff`;
  unknown task → 404; no branch link → 404; label not a real branch → 404; non-repo
  repoPath → 422; hostile label → 400; multiple branch links → last wins; error bodies
  are JSON `{ message }`.

**Phase gate:** web server suite green.

---

## Phase 3 — client parser

- **Files:** `client/src/diff.ts` (new) — `parseUnifiedDiff`, types `ParsedDiff`,
  `DiffFile`, `DiffHunk`, `DiffLine`; `test/client/fixtures/diffs.ts` (new) — captured
  real `git diff` outputs (multi-hunk modify, add, delete, rename ± edits, binary,
  no-newline, mode-only); `test/client/diff.test.ts` (new).
- **Tests:** statuses and paths per fixture; line numbers across hunks; `meta` lines
  (`\ No newline`) get null numbers and don't count; binary flag; per-file and total
  ±counts; empty input → empty result.

**Phase gate:** parser tests green; client typecheck clean.

---

## Phase 4 — viewer + modal

- **Files:** `client/src/components/DiffView.tsx`, `DiffModal.tsx` (new);
  `client/src/board.css` — `.af-diffstat`, `.af-diffmodal`, `.af-diff-file`,
  `.af-diff-filehead`, `.af-diff-badge.{add,del,ren,mod}`, `.af-diff-line.{add,del,ctx,meta}`
  (tokens only).
- **Tests** (`test/client/DiffView.test.tsx`, new): total stat renders; file headers with
  badges and ±counts; collapse toggle hides lines; a >300-line file (generated) starts
  collapsed; binary notice; rename shows `old → new`.

**Phase gate:** component tests green.

---

## Phase 5 — DetailPanel integration

- **Files:** `client/src/api.ts` (`TaskDiff` + `getDiff`);
  `client/src/components/Changes.tsx` (new) — fetch keyed on
  `[taskKey, branchLabel, updatedAt]`, stat + "View diff" → `DiffModal` (no refetch),
  empty/error states; `client/src/components/DetailPanel.tsx` — render `Changes` for the
  last branch link, between Result summary and Links.
- **Tests:** `test/client/Changes.test.tsx` (new; mock `api.getDiff`) — stat after load,
  modal opens with dialog role, error message, empty-diff message;
  `test/client/DetailPanel.test.tsx` — add `getDiff` to the api mock; a branch-linked
  fixture renders the Changes section; the existing pr-only fixture never calls `getDiff`.

**Phase gate:** full web suite green.

---

## Phase 6 — e2e + docs

### 6.1 Loop e2e

- **Files:** `test/server/e2e.diff.test.ts` (new) — temp git repo; workspace created over
  HTTP; task created/queued over HTTP; agent side (core) claims, fixture commits on
  `task/AF-n`, `submitResult` with the branch link; human GETs
  `/api/tasks/<key>/diff` over HTTP — diff contains the change and excludes a
  post-branch main commit; request-changes → second submission with a new branch link →
  diff follows the new branch.

### 6.2 Docs

- **Files:** root `README.md` (one paragraph: reviewing changes from the board); spec/plan
  status → Implemented.

**Final gate:** full `npm test` green; `npm run build` clean.

---

## Risks / watch-outs

- **Windows + git fixtures:** every test creates real repos under `os.tmpdir()` — pin
  identity/signing per call, always `rmSync(…, { recursive: true, force: true })` in
  `afterEach`; WAL/db is untouched (diff tests can use `:memory:` cores).
- **maxBuffer:** 32 MB cap turns runaway diffs into a clean 422, not a hung request.
- **Parser scope creep:** unified format only, no combined diffs (merges never reviewed
  here), no mode-change rendering beyond the header line.
- Estimated touch: ~6 new source files, ~7 new/modified test files, all in `packages/web`.
