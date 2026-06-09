# Agent-Loop Task Board — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **On execution start:** copy this plan to `docs/superpowers/plans/2026-06-09-agent-loop-task-board.md` (the writing-plans convention) so it lives with the spec at `docs/superpowers/specs/2026-06-09-agent-loop-task-board-design.md`.

**Goal:** Build a single-user, local task board ("AgentFactory") that is the persistent state store + UI for an external agent loop — a TypeScript monorepo with a shared `core` (SQLite + lifecycle rules), an `mcp` stdio adapter for the agent, and a `web` adapter (Hono API + SSE + React UI) for the human.

**Architecture:** Three packages over one SQLite file. `core` is the *only* unit that knows the schema and the lifecycle rules; every mutating op runs in one transaction that validates the status transition, mutates rows, appends an activity row, and bumps `updated_at`. `mcp` and `web` are thin adapters that import `core` and inject the actor (`agent` / `human`). The web backend polls a monotonic version (`max(task.updated_at, activity.created_at)`) ~1s and pushes over SSE so the board updates near-instantly as the agent works; the MCP process only writes to SQLite and never knows the web server exists.

**Tech Stack:** TypeScript (ESM, NodeNext, strict) · npm workspaces · `node:sqlite` (`DatabaseSync`, synchronous, zero native deps) · vitest · `@modelcontextprotocol/sdk` · Hono + `@hono/node-server` · React + Vite · zod.

---

## Context

The repo at `c:\Git\AgentFactory` is a greenfield blank slate — only the approved design spec (`docs/superpowers/specs/2026-06-09-agent-loop-task-board-design.md`) and brainstorm notes exist. No `package.json`, source, or lockfile. This plan turns that approved design into working software.

**Why this exists:** It is the "persistent state store + UI" half of [loop engineering](https://addyosmani.com/blog/loop-engineering/): the human writes well-specified tasks and reviews results; an external agent loop pulls queued work and reports back. The tool never runs agents — it is the board the loop reads from and writes to. The agent's interface is an MCP server (native callable tools in an MCP-aware runtime like Claude Code); the human's interface is a Linear-style web board.

**Verified environment facts** (checked on the target machine): Node `v26.1.0`, npm `11.13.0`, **no** pnpm/corepack. `node:sqlite`'s `DatabaseSync` + `PRAGMA journal_mode=WAL` run cleanly on this Node — so we use the built-in driver and avoid all native-module compilation on Windows.

## Locked Decisions

These resolve the ambiguities the design left open. Implement exactly as stated.

| # | Decision | Choice |
|---|----------|--------|
| 1 | Package manager / layout | **npm workspaces**, `packages/{core,mcp,web}`. (pnpm not installed; npm is zero-friction for 3 packages.) |
| 2 | SQLite driver | **`node:sqlite`** (`DatabaseSync`). Synchronous; a small `transaction()` helper wraps `BEGIN IMMEDIATE`/`COMMIT`/`ROLLBACK`. |
| 3 | Module system | ESM everywhere (`"type": "module"`), `moduleResolution: "NodeNext"`, `target: "ES2022"`, strict. |
| 4 | Test runner | **vitest** across all packages (node env for core/mcp/web-server, jsdom for web-client). |
| 5 | Validation | **zod** for domain validation in `core` (one schema per op input) AND at each adapter edge (MCP `inputSchema`, `@hono/zod-validator`). Core never assumes well-formed input. |
| 6 | Core error contract | `core` exports typed error classes: `NotFoundError`, `InvalidTransitionError`, `ValidationError`. Adapters map them (MCP `isError` / HTTP 404·409·400). |
| 7 | Actor source | The **adapter injects the actor**, never the caller. MCP → `'agent'`, web → `'human'`. `updateStatus`/`addComment` take `actor` as an explicit arg. |
| 8 | `updateStatus` signature | `updateStatus(key, status, actor)` — the spec listed `(key, status)`, but core needs `actor` to enforce the human/agent column of the transition table. |
| 9 | Task editing (v1) | **Backlog-only edit.** Add `core.updateTask(key, fields)` that rejects unless status is `backlog`; expose via `PATCH /api/tasks/:key`. |
| 10 | "Recent activity" window | `claimNextTask`/`getTask` return the **last 50** activity rows (constant `RECENT_ACTIVITY_LIMIT = 50`). |
| 11 | `createTask` activity row | One `status_change` with `from_status = null, to_status = 'backlog'`, actor `human` (no new enum value needed). |
| 12 | `addComment` & `updateTask` bump `updated_at` | Yes — so the live version advances and the board reflects new comments/edits. |
| 13 | Comments allowed on any status | Yes, including `done` (commentary is not a transition). |
| 14 | Key prefix | `KEY_PREFIX = 'AF'`, hardcoded for v1; `key = 'AF-' || id`, `seq = id`. |
| 15 | Shared DB path | Both adapters read `AGENTFACTORY_DB` env (default `./agentfactory.db`). That shared file is the entire MCP↔web contract. |

## File Structure

```
c:\Git\AgentFactory\
  package.json                 # private root: workspaces, scripts, shared devDeps
  tsconfig.base.json           # strict shared compiler options
  tsconfig.json                # solution file: references all 3 packages
  vitest.config.ts             # root: test.projects -> per package
  .gitignore  .nvmrc  .editorconfig  README.md
  packages\
    core\                      # schema · migrations · domain ops · validation
      package.json  tsconfig.json
      src\ index.ts db.ts transaction.ts schema.sql migrate.ts types.ts
          errors.ts time.ts transitions.ts keygen.ts validate.ts version.ts
          repo\ tasks.ts activity.ts links.ts
          ops\ createTask.ts updateTask.ts listTasks.ts getTask.ts
              claimNextTask.ts addComment.ts submitResult.ts
              updateStatus.ts reviewApprove.ts reviewRequestChanges.ts
      test\ helpers.ts <one *.test.ts per op + migrate/transitions/version/invariants>
    mcp\                       # stdio MCP server (agent interface)
      package.json  tsconfig.json
      src\ index.ts server.ts types.ts schemas.ts errors.ts
          tools\ listTasks.ts getNextTask.ts getTask.ts addComment.ts submitResult.ts updateStatus.ts
      test\ harness.ts <one *.test.ts per tool + errors + registry>
    web\                       # Hono API + SSE + React UI (human interface)
      package.json  tsconfig.json  vite.config.ts
      server\ index.ts app.ts types.ts errors.ts sse.ts static.ts routes\tasks.ts
      client\ index.html src\ main.tsx App.tsx api.ts types.ts
              useTasks.ts useEventStream.ts
              views\ GroupedList.tsx BoardView.tsx
              components\ TaskRow.tsx StatusColumn.tsx DetailPanel.tsx TaskForm.tsx ReviewActions.tsx CommentBox.tsx StatusBadge.tsx
      test\ server\... client\...
```

**Op task template (applies to every `ops/*` TDD task below):** each follows the same 5-step cycle — (1) write the failing test, (2) run it & confirm it fails, (3) write the minimal op, (4) run it & confirm green, (5) commit. Every mutating op has the identical *shape*: open a `transaction(db, () => { validate → assertTransition (if status changes) → mutate row(s) → appendActivity(...) → set task.updated_at = ts })`, using one shared `ts = nowIso()` so `updated_at` and the activity `created_at` match. `appendActivity` (`repo/activity.ts`) is the **only** writer of the activity table.

---

# Phase 0 — Repo scaffolding

### Task 0.1: Root workspace + tooling

**Files:** Create `package.json`, `tsconfig.base.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.nvmrc`, `.editorconfig`, `README.md` at repo root.

- [ ] **Step 1: Root `package.json`**

```json
{
  "name": "agentfactory",
  "private": true,
  "type": "module",
  "workspaces": ["packages/core", "packages/mcp", "packages/web"],
  "engines": { "node": ">=26" },
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "test:watch": "vitest",
    "mcp": "node packages/mcp/dist/index.js",
    "mcp:dev": "tsx packages/mcp/src/index.ts",
    "web": "node packages/web/server/dist/index.js",
    "web:dev": "npm -w packages/web run dev"
  },
  "devDependencies": {
    "typescript": "^5.6.0",
    "vitest": "^2.1.0",
    "tsx": "^4.19.0",
    "@types/node": "^22.0.0"
  }
}
```

- [ ] **Step 2: `tsconfig.base.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "lib": ["ES2022"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "declaration": true,
    "composite": true,
    "isolatedModules": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

- [ ] **Step 3: Solution `tsconfig.json`** (references built later as packages are added)

```json
{
  "files": [],
  "references": [
    { "path": "packages/core" },
    { "path": "packages/mcp" },
    { "path": "packages/web" }
  ]
}
```

- [ ] **Step 4: Root `vitest.config.ts`**

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/core',
      'packages/mcp',
      'packages/web',
    ],
  },
});
```

- [ ] **Step 5: `.gitignore`, `.nvmrc`, `.editorconfig`, `README.md`**

`.gitignore`:
```
node_modules/
dist/
*.db
*.db-shm
*.db-wal
.DS_Store
```
`.nvmrc`: `26`
`README.md`: short project description, "single-user local board for an agent loop", how to install (`npm install`), run web (`npm run web:dev`), run MCP (`npm run mcp:dev`), and run tests (`npm test`).

- [ ] **Step 6: Install and verify the toolchain**

Run: `npm install`
Then: `npx tsc --version` and `npx vitest --version`
Expected: both print versions, no errors. (No packages have sources yet; this just proves the root installs.)

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "chore: scaffold npm workspace + TS/vitest tooling"
```

---

# Phase 1 — `core` (the foundation)

Build strictly test-first in dependency order: package setup → db/transaction → migrate → types/errors/time → transitions → keygen → repo helpers → ops → version → invariants. `core` has **zero** knowledge of MCP or HTTP.

### Task 1.1: `core` package setup + DB connection + transaction helper

**Files:** Create `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/db.ts`, `packages/core/src/transaction.ts`, `packages/core/test/helpers.ts`. Test: `packages/core/test/db.test.ts`.

- [ ] **Step 1: `packages/core/package.json`**

```json
{
  "name": "@agentfactory/core",
  "version": "0.1.0",
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" } },
  "scripts": { "build": "tsc -b", "test": "vitest run" },
  "dependencies": { "zod": "^3.23.0" }
}
```

- [ ] **Step 2: `packages/core/tsconfig.json`**

```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": { "outDir": "./dist", "rootDir": "./src" },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write the failing test** `packages/core/test/db.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { transaction } from '../src/transaction.js';

describe('openDb', () => {
  it('enables WAL, busy_timeout and foreign keys', () => {
    const db = openDb(':memory:');
    // :memory: reports 'memory' for journal_mode, file dbs report 'wal' — assert pragmas are set without throwing
    expect(db.prepare('PRAGMA busy_timeout').get()).toMatchObject({ timeout: 5000 });
    expect(db.prepare('PRAGMA foreign_keys').get()).toMatchObject({ foreign_keys: 1 });
  });
});

describe('transaction', () => {
  it('commits on success and rolls back on throw', () => {
    const db = openDb(':memory:');
    db.exec('CREATE TABLE t(n INTEGER)');
    transaction(db, () => db.prepare('INSERT INTO t(n) VALUES (1)').run());
    expect(db.prepare('SELECT count(*) c FROM t').get()).toMatchObject({ c: 1 });
    expect(() => transaction(db, () => {
      db.prepare('INSERT INTO t(n) VALUES (2)').run();
      throw new Error('boom');
    })).toThrow('boom');
    expect(db.prepare('SELECT count(*) c FROM t').get()).toMatchObject({ c: 1 });
  });
});
```

- [ ] **Step 4: Run test, confirm it fails**

Run: `npm -w packages/core test`
Expected: FAIL — `openDb`/`transaction` not found.

- [ ] **Step 5: Implement** `packages/core/src/db.ts`

```ts
import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');
  return db;
}
```

`packages/core/src/transaction.ts`:

```ts
import type { DB } from './db.js';

// BEGIN IMMEDIATE acquires the write lock up front so concurrent claimers cannot
// both read the same row. node:sqlite is synchronous, so the closure runs with no interleaving.
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
```

`packages/core/test/helpers.ts` (used by every later test):

```ts
import { openDb, type DB } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

export function makeTestDb(): DB {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}
```

- [ ] **Step 6: Run test, confirm green**

Run: `npm -w packages/core test -- db.test`
Expected: PASS. (`helpers.ts` imports `runMigrations` which lands in Task 1.2 — it is not exercised by `db.test.ts`, so this passes now.)

- [ ] **Step 7: Commit** — `git commit -am "feat(core): db connection (WAL) + transaction helper"`

### Task 1.2: Schema + migrations

**Files:** Create `packages/core/src/schema.sql`, `packages/core/src/migrate.ts`. Test: `packages/core/test/migrate.test.ts`.

- [ ] **Step 1: Write the failing test** `migrate.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { openDb } from '../src/db.js';
import { runMigrations } from '../src/migrate.js';

const tables = (db: any) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r: any) => r.name);

describe('runMigrations', () => {
  it('creates task, activity and link tables and is idempotent', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(tables(db)).toEqual(expect.arrayContaining(['activity', 'link', 'task']));
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
    runMigrations(db); // second run is a no-op
    expect(db.prepare('PRAGMA user_version').get()).toMatchObject({ user_version: 1 });
  });

  it('enforces the status CHECK constraint', () => {
    const db = openDb(':memory:');
    runMigrations(db);
    expect(() => db.prepare(
      "INSERT INTO task(key,title,spec,acceptance_criteria,status,seq,created_at,updated_at) VALUES ('X','t','s','a','nonsense',1,'2026-01-01','2026-01-01')"
    ).run()).toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm fail** — `npm -w packages/core test -- migrate.test` → FAIL (no `runMigrations`).

- [ ] **Step 3: Implement** `packages/core/src/schema.sql` (exact columns from the spec data model)

```sql
CREATE TABLE IF NOT EXISTS task (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  key                 TEXT NOT NULL UNIQUE,
  title               TEXT NOT NULL,
  spec                TEXT NOT NULL,
  acceptance_criteria TEXT NOT NULL,
  status              TEXT NOT NULL
    CHECK (status IN ('backlog','queued','in_progress','in_review','done','blocked')),
  result_summary      TEXT,
  seq                 INTEGER NOT NULL,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id     INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('status_change','comment','result','feedback')),
  actor       TEXT NOT NULL CHECK (actor IN ('human','agent')),
  from_status TEXT,
  to_status   TEXT,
  body        TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS link (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  kind    TEXT NOT NULL CHECK (kind IN ('branch','pr','worktree','log','url')),
  label   TEXT NOT NULL,
  url     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_status_seq ON task(status, seq);
CREATE INDEX IF NOT EXISTS idx_activity_task   ON activity(task_id, id);
CREATE INDEX IF NOT EXISTS idx_task_updated    ON task(updated_at);
CREATE INDEX IF NOT EXISTS idx_activity_created ON activity(created_at);
CREATE INDEX IF NOT EXISTS idx_link_task       ON link(task_id);
```

`packages/core/src/migrate.ts` — numbered migrations (one entry now; structured so lifecycle "C" extensions append later). Read `schema.sql` relative to the compiled module:

```ts
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { DB } from './db.js';
import { transaction } from './transaction.js';

const here = dirname(fileURLToPath(import.meta.url));
// schema.sql is copied next to the compiled JS (see Task 1.x build note) and present in src during tsx/vitest runs.
const MIGRATIONS: ((db: DB) => void)[] = [
  (db) => db.exec(readFileSync(join(here, 'schema.sql'), 'utf8')),
];

export function runMigrations(db: DB): void {
  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  for (let v = user_version; v < MIGRATIONS.length; v++) {
    transaction(db, () => {
      MIGRATIONS[v]!(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
```

> **Build note (add to Task 1.13 / package build):** `schema.sql` is not compiled by `tsc`. Add a `copyfiles`-style step or set `core`'s build script to `tsc -b && node -e "require('fs').copyFileSync('src/schema.sql','dist/schema.sql')"`. During dev (tsx/vitest) the file is read from `src/` so tests pass without a build.

- [ ] **Step 4: Run, confirm green** — `npm -w packages/core test -- migrate.test` → PASS.

- [ ] **Step 5: Commit** — `git commit -am "feat(core): schema + numbered migrations"`

### Task 1.3: Types, errors, time

**Files:** Create `packages/core/src/types.ts` (pure — no `node:sqlite` import, browser-safe so the web client can import it), `packages/core/src/errors.ts`, `packages/core/src/time.ts`. Test: `packages/core/test/errors.test.ts`.

- [ ] **Step 1: Implement `types.ts`** (no test needed — pure types; the op tests exercise them)

```ts
export type Status = 'backlog' | 'queued' | 'in_progress' | 'in_review' | 'done' | 'blocked';
export type Actor = 'human' | 'agent';
export type ActivityType = 'status_change' | 'comment' | 'result' | 'feedback';
export type LinkKind = 'branch' | 'pr' | 'worktree' | 'log' | 'url';

export interface Task {
  id: number; key: string; title: string; spec: string; acceptanceCriteria: string;
  status: Status; resultSummary: string | null; seq: number;
  createdAt: string; updatedAt: string;
}
export interface Activity {
  id: number; taskId: number; type: ActivityType; actor: Actor;
  fromStatus: Status | null; toStatus: Status | null; body: string; createdAt: string;
}
export interface Link { id: number; taskId: number; kind: LinkKind; label: string; url: string; }
export interface TaskDetail extends Task { activity: Activity[]; links: Link[]; }

export interface CreateTaskInput { title: string; spec: string; acceptanceCriteria: string; }
export interface UpdateTaskInput { title?: string; spec?: string; acceptanceCriteria?: string; }
export interface LinkInput { kind: LinkKind; label: string; url: string; }
export interface SubmitResultInput { summary: string; links?: LinkInput[]; }

export const RECENT_ACTIVITY_LIMIT = 50;
export const KEY_PREFIX = 'AF';
```

- [ ] **Step 2: Write the failing test** `errors.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';

describe('error classes', () => {
  it('carry name + message and are instanceof Error', () => {
    for (const E of [NotFoundError, InvalidTransitionError, ValidationError]) {
      const e = new E('msg');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(E.name);
      expect(e.message).toBe('msg');
    }
  });
});
```

- [ ] **Step 3: Run, confirm fail.**

- [ ] **Step 4: Implement `errors.ts` and `time.ts`**

```ts
// errors.ts
export class NotFoundError extends Error { name = 'NotFoundError'; }
export class InvalidTransitionError extends Error { name = 'InvalidTransitionError'; }
export class ValidationError extends Error { name = 'ValidationError'; }
```
```ts
// time.ts — single source of timestamps so updated_at and activity.created_at match per op
export function nowIso(): string { return new Date().toISOString(); }
```

- [ ] **Step 5: Run, confirm green. Commit** — `git commit -am "feat(core): domain types, error classes, time source"`

### Task 1.4: Transition rules (single source of truth)

**Files:** Create `packages/core/src/transitions.ts`. Test: `packages/core/test/transitions.test.ts`.

- [ ] **Step 1: Write the failing test** `transitions.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { isValidTransition } from '../src/transitions.js';

const VALID: [string, string, string][] = [
  ['backlog','queued','human'], ['queued','in_progress','agent'],
  ['in_progress','in_review','agent'], ['in_progress','blocked','agent'],
  ['blocked','in_progress','agent'], ['blocked','queued','human'],
  ['in_review','done','human'], ['in_review','queued','human'],
];

describe('isValidTransition', () => {
  it('accepts every spec edge with the correct actor', () => {
    for (const [f, t, by] of VALID) expect(isValidTransition(f as any, t as any, by as any)).toBe(true);
  });
  it('rejects correct edges performed by the wrong actor', () => {
    expect(isValidTransition('in_review','done','agent')).toBe(false);
    expect(isValidTransition('queued','in_progress','human')).toBe(false);
  });
  it('rejects edges not in the table', () => {
    for (const [f, t] of [['backlog','done'],['queued','in_review'],['in_progress','queued'],['done','queued'],['backlog','in_progress'],['in_review','in_progress'],['done','done']] as const)
      expect(isValidTransition(f as any, t as any, 'human')).toBe(false);
  });
});
```

- [ ] **Step 2: Run, confirm fail.**

- [ ] **Step 3: Implement `transitions.ts`**

```ts
import type { Status, Actor } from './types.js';

export interface TransitionRule { from: Status; to: Status; by: Actor; }

export const TRANSITIONS: readonly TransitionRule[] = [
  { from: 'backlog',     to: 'queued',      by: 'human' },
  { from: 'queued',      to: 'in_progress', by: 'agent' },
  { from: 'in_progress', to: 'in_review',   by: 'agent' },
  { from: 'in_progress', to: 'blocked',     by: 'agent' },
  { from: 'blocked',     to: 'in_progress', by: 'agent' },
  { from: 'blocked',     to: 'queued',      by: 'human' },
  { from: 'in_review',   to: 'done',        by: 'human' },
  { from: 'in_review',   to: 'queued',      by: 'human' },
] as const;

export function isValidTransition(from: Status, to: Status, by: Actor): boolean {
  return TRANSITIONS.some(t => t.from === from && t.to === to && t.by === by);
}

import { InvalidTransitionError } from './errors.js';
export function assertTransition(from: Status, to: Status, by: Actor): void {
  if (!isValidTransition(from, to, by))
    throw new InvalidTransitionError(`${from} -> ${to} not allowed for ${by}`);
}
```

- [ ] **Step 4: Run green. Commit** — `git commit -am "feat(core): lifecycle transition rules"`

### Task 1.5: Repo helpers (row mapping, key/seq, activity append, links)

**Files:** Create `packages/core/src/keygen.ts`, `packages/core/src/repo/tasks.ts`, `packages/core/src/repo/activity.ts`, `packages/core/src/repo/links.ts`, `packages/core/src/validate.ts`. Tested indirectly through the op tasks (1.6–1.14); no dedicated test file (these are internal helpers exercised by every op test).

- [ ] **Step 1: Implement `repo/tasks.ts`** — typed row ↔ domain mapping + low-level reads/writes.

```ts
import type { DB } from '../db.js';
import type { Task, Status } from '../types.js';

interface TaskRow {
  id: number; key: string; title: string; spec: string; acceptance_criteria: string;
  status: Status; result_summary: string | null; seq: number; created_at: string; updated_at: string;
}
const toTask = (r: TaskRow): Task => ({
  id: r.id, key: r.key, title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria,
  status: r.status, resultSummary: r.result_summary, seq: r.seq, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function findByKey(db: DB, key: string): Task | null {
  const r = db.prepare('SELECT * FROM task WHERE key = ?').get(key) as TaskRow | undefined;
  return r ? toTask(r) : null;
}
export function setStatus(db: DB, id: number, status: Status, ts: string): void {
  db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
}
export function touch(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, id);
}
// + setResultSummary, applyEdit (title/spec/acceptance), listRows({status}), oldestQueued() — small typed wrappers.
export { toTask };
export type { TaskRow };
```

- [ ] **Step 2: Implement `repo/activity.ts`** — the ONLY writer of the activity table.

```ts
import type { DB } from '../db.js';
import type { Activity, ActivityType, Actor, Status } from '../types.js';

export interface AppendActivity {
  taskId: number; type: ActivityType; actor: Actor;
  fromStatus?: Status | null; toStatus?: Status | null; body?: string; createdAt: string;
}
export function appendActivity(db: DB, a: AppendActivity): void {
  db.prepare(
    `INSERT INTO activity(task_id,type,actor,from_status,to_status,body,created_at)
     VALUES (?,?,?,?,?,?,?)`
  ).run(a.taskId, a.type, a.actor, a.fromStatus ?? null, a.toStatus ?? null, a.body ?? '', a.createdAt);
}
export function recentActivity(db: DB, taskId: number, limit: number): Activity[] {
  const rows = db.prepare(
    'SELECT * FROM activity WHERE task_id = ? ORDER BY id DESC LIMIT ?'
  ).all(taskId, limit) as any[];
  return rows.reverse().map(r => ({
    id: r.id, taskId: r.task_id, type: r.type, actor: r.actor,
    fromStatus: r.from_status, toStatus: r.to_status, body: r.body, createdAt: r.created_at,
  }));
}
```

- [ ] **Step 3: Implement `repo/links.ts`** (`insertLinks(db, taskId, links)`, `linksFor(db, taskId)`) and `keygen.ts`:

```ts
// keygen.ts — called inside createTask's transaction after insert
import type { DB } from '../db.js';
import { KEY_PREFIX } from '../types.js';
export function assignKeyAndSeq(db: DB, id: number): string {
  const key = `${KEY_PREFIX}-${id}`;
  db.prepare('UPDATE task SET key = ?, seq = ? WHERE id = ?').run(key, id, id);
  return key;
}
```

- [ ] **Step 4: Implement `validate.ts`** — zod schemas, one per op input; throw `ValidationError` on failure.

```ts
import { z } from 'zod';
import { ValidationError } from './errors.js';
const nonEmpty = z.string().trim().min(1);

export const createTaskSchema = z.object({ title: nonEmpty, spec: nonEmpty, acceptanceCriteria: nonEmpty });
export const updateTaskSchema = z.object({ title: nonEmpty.optional(), spec: nonEmpty.optional(), acceptanceCriteria: nonEmpty.optional() })
  .refine(o => Object.keys(o).length > 0, 'at least one field required');
export const submitResultSchema = z.object({
  summary: nonEmpty,
  links: z.array(z.object({ kind: z.enum(['branch','pr','worktree','log','url']), label: nonEmpty, url: nonEmpty })).default([]),
});
export const commentSchema = z.object({ body: nonEmpty });
export const feedbackSchema = z.object({ feedback: nonEmpty });

export function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const r = schema.safeParse(input);
  if (!r.success) throw new ValidationError(r.error.issues.map(i => i.message).join('; '));
  return r.data;
}
```

- [ ] **Step 5: Commit** — `git commit -am "feat(core): repo helpers, keygen, zod validation"`

### Task 1.6: `createTask`

**Files:** Create `packages/core/src/ops/createTask.ts`. Test: `packages/core/test/createTask.test.ts`. Follow the op task template.

- [ ] **Test cases (write these as the failing test first):**
  - Creates a task in `backlog` with title/spec/acceptanceCriteria persisted and returned as a `Task`.
  - Assigns `key` `AF-1` then `AF-2` on successive creates; `seq` equals the numeric id and is monotonic.
  - `createdAt === updatedAt`, both valid ISO strings.
  - Writes exactly one activity row: `type='status_change'`, `actor='human'`, `fromStatus=null`, `toStatus='backlog'`.
  - Rejects empty/whitespace `title`, `spec`, or `acceptanceCriteria` with `ValidationError` (and writes nothing).

- [ ] **Implementation sketch** (then run green + commit):

```ts
import type { DB } from '../db.js';
import type { Task, CreateTaskInput } from '../types.js';
import { transaction } from '../transaction.js';
import { createTaskSchema, parse } from '../validate.js';
import { assignKeyAndSeq } from '../keygen.js';
import { appendActivity } from '../repo/activity.js';
import { findByKey } from '../repo/tasks.js';
import { nowIso } from '../time.js';

export function createTask(db: DB, input: CreateTaskInput, now = nowIso): Task {
  const { title, spec, acceptanceCriteria } = parse(createTaskSchema, input);
  return transaction(db, () => {
    const ts = now();
    const info = db.prepare(
      `INSERT INTO task(key,title,spec,acceptance_criteria,status,result_summary,seq,created_at,updated_at)
       VALUES ('',?,?,?,'backlog',NULL,0,?,?)`
    ).run(title, spec, acceptanceCriteria, ts, ts);
    const id = Number(info.lastInsertRowid);
    const key = assignKeyAndSeq(db, id);
    appendActivity(db, { taskId: id, type: 'status_change', actor: 'human', fromStatus: null, toStatus: 'backlog', createdAt: ts });
    return findByKey(db, key)!;
  });
}
```
Commit: `git commit -am "feat(core): createTask"`

### Task 1.7: `updateTask` (Backlog-only edit — Decision #9)

**Files:** `packages/core/src/ops/updateTask.ts`. Test: `test/updateTask.test.ts`.

- [ ] **Test cases:**
  - Edits `title`/`spec`/`acceptanceCriteria` (any subset) of a `backlog` task; returns updated `Task`; bumps `updatedAt`.
  - **Rejects** with `InvalidTransitionError` (or `ValidationError` — pick `InvalidTransitionError` for "not editable in this status") when the task is not `backlog` (seed a `queued`/`in_progress` task).
  - Rejects empty payload (no fields) and empty-string fields with `ValidationError`.
  - Unknown key → `NotFoundError`.
  - Writes no `status_change` activity (status unchanged); does NOT append an activity row (edit is not part of the timeline in v1) but DOES bump `updatedAt` so the board refreshes.

- [ ] **Implementation:** validate with `updateTaskSchema`; `findByKey` (→ `NotFoundError` if null); if `status !== 'backlog'` throw `InvalidTransitionError('only backlog tasks are editable')`; in a transaction apply the provided fields + `touch(db, id, ts)`. Run green; commit `feat(core): updateTask (backlog-only edit)`.

### Task 1.8: `listTasks`

**Files:** `packages/core/src/ops/listTasks.ts`. Test: `test/listTasks.test.ts`.

- [ ] **Test cases:** no filter → all tasks ordered by `seq`; `{status}` filter → only that status; read-only (appends no activity, does not change `updatedAt`). **Impl:** `listRows(db, {status})` mapped via `toTask`; commit.

### Task 1.9: `getTask`

**Files:** `packages/core/src/ops/getTask.ts`. Test: `test/getTask.test.ts`.

- [ ] **Test cases:** returns `TaskDetail` with `activity` (chronological, capped at `RECENT_ACTIVITY_LIMIT`) and `links`; unknown key → `NotFoundError`; read-only. **Impl:** `findByKey` (→`NotFoundError`), `recentActivity(db, id, RECENT_ACTIVITY_LIMIT)`, `linksFor(db, id)`. Commit.

### Task 1.10: `claimNextTask` (atomic FIFO — the critical correctness task)

**Files:** `packages/core/src/ops/claimNextTask.ts`. Test: `test/claimNextTask.test.ts`.

- [ ] **Test cases (write all before implementing):**
  - Seed 3 queued tasks (AF-1, AF-2, AF-3); successive claims return AF-1, then AF-2, then AF-3 (FIFO by `seq`).
  - Claimed task is now `in_progress` with bumped `updatedAt`; a `status_change` activity (`agent`, queued→in_progress) is appended.
  - Returns full `TaskDetail` whose `activity` includes prior `feedback` rows (seed a `feedback` activity, then claim, assert it's present — proves the agent sees review feedback).
  - Returns `null` when no `queued` task exists.
  - Does not claim `backlog`/`blocked`/etc. tasks even if older by `seq`.
  - **Atomicity:** with exactly one queued task, two sequential claims → first returns the task, second returns `null` (never the same task twice).

- [ ] **Implementation:**

```ts
import type { DB } from '../db.js';
import type { TaskDetail } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { transaction } from '../transaction.js';
import { appendActivity, recentActivity } from '../repo/activity.js';
import { linksFor } from '../repo/links.js';
import { toTask, type TaskRow } from '../repo/tasks.js';
import { nowIso } from '../time.js';

export function claimNextTask(db: DB, now = nowIso): TaskDetail | null {
  return transaction(db, () => {
    const row = db.prepare(
      `SELECT * FROM task WHERE status='queued' ORDER BY seq ASC LIMIT 1`
    ).get() as TaskRow | undefined;
    if (!row) return null;
    const ts = now();
    db.prepare(`UPDATE task SET status='in_progress', updated_at=? WHERE id=? AND status='queued'`).run(ts, row.id);
    appendActivity(db, { taskId: row.id, type: 'status_change', actor: 'agent', fromStatus: 'queued', toStatus: 'in_progress', createdAt: ts });
    const task = toTask({ ...row, status: 'in_progress', updated_at: ts });
    return { ...task, activity: recentActivity(db, row.id, RECENT_ACTIVITY_LIMIT), links: linksFor(db, row.id) };
  });
}
```
Run green; commit `feat(core): claimNextTask atomic FIFO claim`.

> **Optional cross-process integration test** (`test/claim-concurrency.test.ts`): open two `openDb(tmpFile)` handles on a real temp file (not `:memory:`), seed one queued task, claim from both — assert exactly one wins and the other returns `null`. This exercises WAL + `busy_timeout`. Use a `tmp` path under the OS temp dir; delete the `.db`/`-wal`/`-shm` files in `afterEach`.

### Task 1.11: `addComment`

**Files:** `packages/core/src/ops/addComment.ts`. Test: `test/addComment.test.ts`. Signature: `addComment(db, key, { actor, body }, now?)`.

- [ ] **Test cases:** appends a `comment` activity with the given `actor` + `body`; does NOT change status; bumps `updatedAt` (Decision #12); allowed in any status incl. `done` (Decision #13); empty body → `ValidationError`; unknown key → `NotFoundError`. **Impl:** validate body, `findByKey` (→`NotFoundError`), transaction: `appendActivity({type:'comment', actor, body, createdAt:ts})` + `touch`. Commit.

### Task 1.12: `submitResult`

**Files:** `packages/core/src/ops/submitResult.ts`. Test: `test/submitResult.test.ts`. Signature: `submitResult(db, key, { summary, links }, now?)`.

- [ ] **Test cases:** from `in_progress` → `in_review`; sets `resultSummary`; inserts each provided link into `link`; appends a `result` activity (`agent`, body=summary) AND a `status_change`; **rejects** with `InvalidTransitionError` from any non-`in_progress` status (`queued`/`in_review`/`done`/`blocked`/`backlog`); empty summary → `ValidationError`; unknown key → `NotFoundError`. **Impl:** validate with `submitResultSchema`; `findByKey`; `assertTransition(status,'in_review','agent')`; transaction: `setStatus`→in_review, `setResultSummary`, `insertLinks`, append `result` + `status_change`. Commit.

### Task 1.13: `updateStatus(key, status, actor)` (Decision #8)

**Files:** `packages/core/src/ops/updateStatus.ts`. Test: `test/updateStatus.test.ts`.

- [ ] **Test cases:**
  - Allows `in_progress→blocked` (agent), `blocked→in_progress` (agent), `blocked→queued` (human), `backlog→queued` (human); each writes a `status_change` with correct actor + from/to and bumps `updatedAt`.
  - **Rejects** (parametrized) invalid edges and wrong-actor attempts: `backlog→in_progress`, `queued→done`, `in_progress→done`, `done→queued`, `in_progress→queued`, `in_review→done` via this op when actor=agent, etc. → `InvalidTransitionError`.
  - Unknown key → `NotFoundError`.
  - **Impl:** `findByKey`; `assertTransition(current, status, actor)`; transaction: `setStatus` + append `status_change`. Commit `feat(core): updateStatus with actor enforcement`.

### Task 1.14: `reviewApprove` & `reviewRequestChanges`

**Files:** `packages/core/src/ops/reviewApprove.ts`, `packages/core/src/ops/reviewRequestChanges.ts`. Tests: `test/reviewApprove.test.ts`, `test/reviewRequestChanges.test.ts`.

- [ ] **`reviewApprove(db, key, now?)` cases:** `in_review`→`done`; `status_change` (human); rejects from any non-`in_review` with `InvalidTransitionError`; unknown key → `NotFoundError`; bumps `updatedAt`.
- [ ] **`reviewRequestChanges(db, key, { feedback }, now?)` cases:** `in_review`→`queued`; appends a `feedback` activity (`human`, body=feedback) AND a `status_change`; the feedback is visible to the next `claimNextTask` (assert by claiming and checking the returned `activity` contains the feedback — the spec's core loop); rejects from non-`in_review`; empty feedback → `ValidationError`. **Impl:** both use `assertTransition(...,'human')`. Commit each.

### Task 1.15: `version` (live-update token)

**Files:** `packages/core/src/version.ts`. Test: `test/version.test.ts`.

- [ ] **Test cases:** empty db → `''`; after `createTask`, equals that task's `updatedAt`; after a later `addComment`, strictly advances; equals `max(max(task.updated_at), max(activity.created_at))`. **Impl:**

```ts
import type { DB } from './db.js';
export function getVersion(db: DB): string {
  const r = db.prepare(
    `SELECT MAX(v) v FROM (SELECT MAX(updated_at) v FROM task UNION ALL SELECT MAX(created_at) v FROM activity)`
  ).get() as { v: string | null };
  return r.v ?? '';
}
```
Commit `feat(core): monotonic version for live updates`.

### Task 1.16: Public API barrel + cross-cutting invariant test + build

**Files:** `packages/core/src/index.ts`. Test: `packages/core/test/invariants.test.ts`.

- [ ] **`index.ts`** re-exports: `openDb`, `runMigrations`, all ops (free functions), `getVersion`, all of `types.ts`, and the three error classes. It ALSO exports a **`createCore(db)` factory** that returns an object whose methods are the ops bound to `db` — `{ createTask(input), updateTask(key, fields), listTasks(opts), getTask(key), claimNextTask(), addComment(key, {actor, body}), submitResult(key, input), updateStatus(key, status, actor), reviewApprove(key), reviewRequestChanges(key, {feedback}), getVersion() }`. **Core's own tests call the free functions directly with a raw `db`** (as written in Tasks 1.6–1.15); **the `mcp` and `web` adapters consume `createCore(db)`** so their call sites read `core.createTask(...)` and a fake core in adapter tests is simply `createCore(makeTestDb())`. `export type Core = ReturnType<typeof createCore>`.
- [ ] **Invariant test:** for every mutating op (`createTask`, `updateStatus`, `claimNextTask`, `addComment`, `submitResult`, `reviewApprove`, `reviewRequestChanges`), assert that after the op (a) `getVersion` advanced and (b) for status-changing ops an activity row exists for the task. This centrally guards the spec's "every op appends to activity / bumps updated_at" rule so a future op can't silently skip it. (`updateTask` bumps version but intentionally writes no activity — assert version-only.)
- [ ] **Build step:** set `core` build script to `tsc -b && node -e "require('node:fs').copyFileSync('src/schema.sql','dist/schema.sql')"` so `schema.sql` ships to `dist`.
- [ ] **Run the whole core suite:** `npm -w packages/core test` → all green. Commit `feat(core): public API barrel + invariant guard`.

---

# Phase 2 — `mcp` adapter (agent interface)

Thin stdio server over `core`. Build `server.ts` as `buildServer(core)` (dependency-injected) so tests drive it over `InMemoryTransport`; `index.ts` is the only file doing real I/O.

### Task 2.1: `mcp` package setup + shared schemas + error mapping

**Files:** `packages/mcp/package.json`, `tsconfig.json`, `src/types.ts`, `src/schemas.ts`, `src/errors.ts`. Test: `packages/mcp/test/errors.test.ts`.

- [ ] **`package.json`:** name `@agentfactory/mcp`, `"type":"module"`, `bin: { "agentfactory-mcp": "dist/index.js" }`, deps `@modelcontextprotocol/sdk`, `zod`, `@agentfactory/core: "*"`. `tsconfig.json` extends base, `references: [{ "path": "../core" }]`.
- [ ] **`src/types.ts`:** `export type { Core } from '@agentfactory/core'` (the `createCore(db)` return type from Task 1.16) — tools are typed against it and tests inject `createCore(makeTestDb())` (wrapping a real `:memory:` core is simplest).
- [ ] **`src/schemas.ts`:** `StatusEnum`, `LinkSchema`, `taskKey` regex (`/^AF-\d+$/`) — as zod, reused by tool `inputSchema`.
- [ ] **`src/errors.ts` + test:** `toToolError(err)` maps `NotFoundError`/`InvalidTransitionError`/`ValidationError` to `{ isError: true, content: [{type:'text', text}] }` with a distinct prefix each; unknown → "Unexpected error". Test asserts each mapping. Commit.

### Task 2.2: `buildServer` + tool registry test

**Files:** `packages/mcp/src/server.ts`, `packages/mcp/test/harness.ts`, `packages/mcp/test/registry.test.ts`.

- [ ] **`harness.ts`:** `makeClient(core)` wires a real `Client` to `buildServer(core)` over `InMemoryTransport.createLinkedPair()` (see design); returns `{ client, core }`.
- [ ] **Registry test (write first):** `client.listTools()` returns exactly the six tools — `list_tasks`, `get_next_task`, `get_task`, `add_comment`, `submit_result`, `update_status` — and **no `create_task`** (task creation is human-only). This locks the v1 agent contract.
- [ ] **`server.ts`:** `buildServer(core)` constructs `new McpServer({ name:'agentfactory', version:'0.1.0' })` and calls the six `register*` functions (added next). Run green; commit.

### Task 2.3: The six tools (one TDD task each)

Each tool: file under `src/tools/`, registered via `server.registerTool(name, { title, description, inputSchema, outputSchema }, handler)` where `inputSchema` is a **ZodRawShape** (plain object map, not `z.object`). Handler calls the mapped core op, returns `{ structuredContent, content:[{type:'text', text}] }`, and wraps core calls in `try/catch → toToolError`. Actor is hardcoded `'agent'` where applicable. Use `submit_result` (design doc) as the canonical example.

- [ ] **`list_tasks`** → `core.listTasks({status})`. Test: seeded mixed statuses; no-arg returns all; `{status:'queued'}` filters.
- [ ] **`get_next_task`** → `core.claimNextTask()`. Test: two queued → returns older, core now `in_progress`; empty queue → **non-error** result with `structuredContent.task === null` and text "No queued tasks." (not `isError`).
- [ ] **`get_task`** (`{key}`) → `core.getTask(key)`. Test: returns detail incl. activity; unknown key → `isError` "not found".
- [ ] **`add_comment`** (`{key, body}`) → `core.addComment(key, {actor:'agent', body})`. Test: comment recorded with **agent** actor (adapter injects it, not the caller).
- [ ] **`submit_result`** (`{key, summary, links[]}`) → `core.submitResult(...)`. Test: `in_progress`→`in_review` + links persisted; on a `backlog` task → `isError` "invalid transition".
- [ ] **`update_status`** (`{key, status}`) → `core.updateStatus(key, status, 'agent')`. Description tells the agent the only valid uses are `→ blocked` and `blocked → in_progress`. Test: `in_progress→blocked` succeeds; `in_review→done` via this tool → `isError` (core rejects agent on that edge).
- [ ] **Input-schema rejection test:** call `submit_result` with a malformed `links` entry → SDK returns a validation error **before** core is touched (assert the core spy was not called).

Commit after each tool goes green.

### Task 2.4: `index.ts` entry (stdio) + client config doc

**Files:** `packages/mcp/src/index.ts`, plus a short `packages/mcp/README.md`.

- [ ] **`index.ts`:** open core with `process.env.AGENTFACTORY_DB ?? './agentfactory.db'`, run migrations, `buildServer(core)`, `server.connect(new StdioServerTransport())`. **Never write to stdout except via the transport** — all diagnostics to `console.error`.
- [ ] **README:** the MCP client config entry (dev `tsx`, prod `node dist/index.js`) pointing `AGENTFACTORY_DB` at the shared DB file:
```json
{ "mcpServers": { "agentfactory": {
  "command": "node", "args": ["c:\\Git\\AgentFactory\\packages\\mcp\\dist\\index.js"],
  "env": { "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db" } } } }
```
- [ ] **Manual smoke:** `npm -w packages/mcp run build && node packages/mcp/dist/index.js` — process starts, waits on stdio (Ctrl-C to exit). Commit.

---

# Phase 3 — `web` backend (Hono API + SSE)

Single `web` package with `server/` (Hono) and `client/` (React); Vite proxies `/api` + `/events` to Hono in dev; Hono serves `client/dist` in prod. Build the API as `buildApp(core)` so tests use Hono's `app.request(...)` against a real `:memory:` core.

### Task 3.1: `web` package setup + error mapping

**Files:** `packages/web/package.json`, `tsconfig.json`, `vite.config.ts`, `server/types.ts`, `server/errors.ts`. Test: `packages/web/test/server/errors.test.ts`.

- [ ] **`package.json`:** name `@agentfactory/web`, deps `hono`, `@hono/node-server`, `@hono/zod-validator`, `zod`, `@agentfactory/core: "*"`, `react`, `react-dom`; devDeps `vite`, `@vitejs/plugin-react`, `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`. Scripts: `dev` (concurrently Vite + `tsx watch server/index.ts`), `build` (`tsc -b server` + `vite build`), `start`, `test`.
- [ ] **`vite.config.ts`:** root `client/`, `@vitejs/plugin-react`, `server.proxy` for `/api` and `/events` → `http://localhost:8787`.
- [ ] **`server/types.ts`:** `export type { Core } from '@agentfactory/core'` — `buildApp`/`taskRoutes`/`sse` are typed against it; server tests inject `createCore(makeTestDb())`.
- [ ] **`server/errors.ts` + test:** `mapError(err)` → Hono `HTTPException` with 404 (`NotFoundError`), 409 (`InvalidTransitionError`), 400 (`ValidationError`), 500 (otherwise). Test asserts each. Commit.

### Task 3.2: REST routes + `buildApp`

**Files:** `packages/web/server/routes/tasks.ts`, `packages/web/server/app.ts`. Test: `packages/web/test/server/tasks.test.ts`.

Endpoints (each maps 1:1 to a core op; actor `'human'` injected server-side; bodies validated with `@hono/zod-validator`):

| Method & path | Body | core op |
|---|---|---|
| `GET /api/tasks?status=` | — | `listTasks({status})` |
| `GET /api/tasks/:key` | — | `getTask(key)` → 404 if missing |
| `POST /api/tasks` | `{title,spec,acceptanceCriteria}` | `createTask(...)` → 201 |
| `PATCH /api/tasks/:key` | `{title?,spec?,acceptanceCriteria?}` | `updateTask(key, fields)` → 200/409 (non-backlog) |
| `POST /api/tasks/:key/comment` | `{body}` | `addComment(key,{actor:'human',body})` → 201 |
| `POST /api/tasks/:key/status` | `{status}` | `updateStatus(key,status,'human')` |
| `POST /api/tasks/:key/approve` | — | `reviewApprove(key)` |
| `POST /api/tasks/:key/request-changes` | `{feedback}` | `reviewRequestChanges(key,{feedback})` |

- [ ] **Tests (write first):** each row above — happy path + the key failure (404 unknown key; 409 invalid transition e.g. `POST /status {done}` on a backlog task; 400 missing `title` / empty `feedback`); `POST /comment` records `actor:'human'` (server-injected, ignores any actor in the body). Use `app.request('/api/...', { method, body })`.
- [ ] **`app.ts`:** `buildApp(core)` mounts `app.route('/api/tasks', taskRoutes(core))`, registers SSE (Task 3.3), sets `app.onError((e,c) => (e instanceof HTTPException ? e.getResponse() : mapError(e).getResponse()))`, and in prod mounts static (Task 3.4). Run green; commit.

### Task 3.3: SSE live-update stream

**Files:** `packages/web/server/sse.ts`. Test: `packages/web/test/server/sse.test.ts`.

- [ ] **Test (write first):** connect to `/events` via `app.request`; read the initial `version` event; mutate core (`claimNextTask` or `createTask`); assert a new `version` event with a higher value is pushed. Assert no `version` event fires on a no-op tick (only `ping`).
- [ ] **Implement** with `hono/streaming` `streamSSE`: initial `version` event = `core.getVersion()`; loop while open: re-read version, push `version` event if changed else a `ping` heartbeat, `await stream.sleep(1000)`. Payload is just the version string — the client treats any bump as "refetch". (See design doc for the exact handler.) Commit.

### Task 3.4: Static serving + server entry

**Files:** `packages/web/server/static.ts`, `packages/web/server/index.ts`.

- [ ] **`static.ts`:** in production, `serveStatic` from `client/dist` with SPA fallback to `index.html`.
- [ ] **`index.ts`:** open core (`AGENTFACTORY_DB`), run migrations, `serve({ fetch: buildApp(core).fetch, port: 8787 })` via `@hono/node-server`. Log the URL to stderr/stdout.
- [ ] **Manual smoke:** `npm -w packages/web run dev` (or build+start) → `GET http://localhost:8787/api/tasks` returns `[]` on a fresh DB. Commit.

---

# Phase 4 — `web` frontend (React board)

Default grouped-list + slide-over detail; board view one toggle away. Plain hooks + fetch + SSE-driven refetch (no React Query — single user). Shared DTO types imported from `@agentfactory/core` **types only** (never the driver). Client tests: React Testing Library + jsdom, mocking `api.ts` and `EventSource`.

### Task 4.1: API client + live-update hooks

**Files:** `client/src/types.ts` (re-export core domain types for the browser), `client/src/api.ts`, `client/src/useEventStream.ts`, `client/src/useTasks.ts`. Test: `test/client/useEventStream.test.tsx`.

- [ ] **`api.ts`:** typed `fetch` wrappers for every endpoint in Task 3.2 (`getTasks(status?)`, `getTask(key)`, `createTask`, `updateTask`, `addComment`, `setStatus`, `approve`, `requestChanges`), throwing on non-2xx with the server message.
- [ ] **`useEventStream(onBump)`** (test first): mock `EventSource`; firing a `version` event calls `onBump`; firing `error` starts a 3s polling fallback; on reconnect (`open`/next `version`) polling stops. (See design doc for the hook.)
- [ ] **`useTasks(status?)`:** fetch list on mount + on every `useEventStream` bump → `refetch`. Commit.

### Task 4.2: Views + detail + forms + review actions

**Files:** `client/src/App.tsx`, `views/GroupedList.tsx`, `views/BoardView.tsx`, `components/{TaskRow,StatusColumn,DetailPanel,TaskForm,ReviewActions,CommentBox,StatusBadge}.tsx`, `main.tsx`, `index.html`. Tests under `test/client/`.

- [ ] **`StatusBadge`:** color map (in_progress amber, in_review blue, done green, queued/backlog grey, blocked red). No test needed (cosmetic).
- [ ] **`GroupedList` (test):** renders tasks grouped under status headers in lifecycle order; clicking a row selects it / opens `DetailPanel`.
- [ ] **`BoardView` (test):** places each task in its status column; `App` view toggle switches list↔board.
- [ ] **`DetailPanel` (test):** mounted with `key={selectedKey}`; fetches `getTask`; shows spec, acceptance, result summary, links, and the activity thread. Hosts `CommentBox` (human comment → `api.addComment`), a "Release to Queued" button on `backlog` (→ `api.setStatus(key,'queued')`), the `TaskForm` edit mode on `backlog`, and `ReviewActions` on `in_review`.
- [ ] **`TaskForm` (test):** create mode submits `{title,spec,acceptanceCriteria}` → `api.createTask`; edit mode (backlog only) → `api.updateTask`. On success, triggers refetch.
- [ ] **`ReviewActions` (test):** renders only when status is `in_review`; "Approve" → `api.approve(key)`; "Request changes" requires non-empty feedback then `api.requestChanges(key, feedback)`.
- [ ] **`App.tsx`:** owns `view` ('list'|'board') and `selectedKey`; renders header (toggle + "New task"), the active view, and the detail slide-over. Commit.

### Task 4.3: Frontend build wiring

- [ ] **Verify** `npm -w packages/web run build` produces `client/dist` and `server/dist`; `npm -w packages/web run dev` serves the UI with HMR and proxies API/SSE. Commit `feat(web): React board UI`.

---

# Phase 5 — End-to-end verification

Goal: prove the full feed-and-follow-up loop works across both adapters over one shared SQLite file.

- [ ] **Step 1: Full test suite green**

Run: `npm test` (root — runs all three vitest projects)
Expected: all of `core`, `mcp`, `web` suites PASS.

- [ ] **Step 2: Typecheck & build**

Run: `npm run build` (root `tsc -b` across project references) + `npm -w packages/web run build`
Expected: no TS errors; `packages/*/dist` and `web/client/dist` produced.

- [ ] **Step 3: Manual end-to-end loop (the spec's core scenario)**

Use a single shared DB so both processes see each other's writes:
```powershell
$env:AGENTFACTORY_DB = "c:\Git\AgentFactory\agentfactory.db"
```
1. Start the web app (`npm -w packages/web run dev`) and open it. **Create** a task (title/spec/acceptance) → it appears in **Backlog**. Click **Release** → moves to **Queued**.
2. In an MCP client (config from Task 2.4) pointed at the same `AGENTFACTORY_DB`, call **`get_next_task`** → returns the task; the board shows it flip to **In Progress** within ~1s (SSE). Call **`add_comment`** → the note appears in the detail panel's activity thread live.
3. Call **`submit_result`** with a summary + a link → board flips to **In Review**; result + link render in the panel.
4. In the UI, click **Request changes** with feedback → task returns to **Queued**; the feedback shows in the thread.
5. Call **`get_next_task`** again → the same task is re-claimed and the returned `activity` **includes the feedback** (the follow-up loop). Call **`submit_result`** again → **In Review**.
6. In the UI, click **Approve** → task moves to **Done** (terminal). Confirm `update_status` cannot move it anywhere else (agent calling `update_status` on a done/in_review task returns an `isError` invalid-transition result).

- [ ] **Step 4: Concurrency sanity**

With the web app running, call `get_next_task` twice quickly against two queued tasks → two distinct tasks claimed, none claimed twice (WAL + `busy_timeout` + `BEGIN IMMEDIATE`). The optional `claim-concurrency.test.ts` (Task 1.10) automates this.

- [ ] **Step 5: Finish the branch**

Use superpowers:finishing-a-development-branch to decide merge/PR. Suggested final commit message: `feat: agent-loop task board (core + mcp + web)`.

---

## Spec Coverage Check

- **Lifecycle + valid transitions** → `transitions.ts` (Task 1.4) + per-op enforcement (1.6–1.14); invalid transitions rejected and tested.
- **Feed-and-follow-up loop** → `claimNextTask` returns recent activity incl. feedback (1.10); `reviewRequestChanges` writes feedback → queued (1.14); E2E Step 3–6.
- **MCP tools (6, no create_task)** → Phase 2; registry test locks the contract (2.2).
- **Web: grouped list + board toggle + detail + create/edit + approve/request-changes** → Phase 4; REST in 3.2.
- **Live updates (monotonic version, SSE, polling fallback)** → `getVersion` (1.15), `sse.ts` (3.3), `useEventStream` (4.1).
- **Concurrency (WAL + busy_timeout)** → `db.ts` (1.1), `BEGIN IMMEDIATE` claim (1.10), E2E Step 4.
- **Data model (task/activity/link, exact columns)** → `schema.sql` (1.2).
- **Testing priorities (core first, then adapters)** → Phases 1→2→3→4, core fully test-first with an invariant guard (1.16).
- **Non-goals (auth, multi-board, priority, labels, dependencies, agent create_task, scheduling, git orchestration)** → none implemented; FIFO ordering via `seq`.
