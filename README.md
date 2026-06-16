# AgentFactory

AgentFactory: a single-user local task board that is the persistent state store + UI for an external agent loop.

## Stack

TypeScript monorepo (npm workspaces) with five packages:

- **`core`** — node:sqlite + lifecycle rules (shared business logic and DB layer)
- **`mcp`** — stdio MCP server (exposes task board operations to agent loops)
- **`web`** — Hono API + SSE + React/Vite UI (browser-based task board interface)
- **`dispatcher`** — headless worker supervisor (spawns one fresh `claude -p` session per queued task)
- **`reviewer`** — headless review supervisor (spawns a codex/claude session per `in_review` task to post an `ai-review/v1` verdict)

**Requires Node >= 26.**

## Getting Started

### Install dependencies

```bash
npm install
```

### Run web UI (dev mode)

Dev mode needs two processes: the API server and the Vite client (which proxies `/api` and `/events` to it).

```bash
# terminal 1 — Hono API + SSE on port 8787
npm run web:dev:server

# terminal 2 — Vite client on port 5173
npm run web:dev
```

The server stores its data in `agentfactory.db` (override with the `AGENTFACTORY_DB` env var — the path is resolved relative to the working directory, so point both the web server and the MCP server at the same absolute path).

### Run MCP server (dev mode)

```bash
npm run mcp:dev
```

### Run the dispatcher (unattended workers)

For a standing worker with no human in the loop, the dispatcher polls the DB for queued tasks and spawns **one fresh headless `claude -p` session per task** — the session claims via `get_next_task`, works to `submit_result`, and exits, so every attempt starts with the current MCP build and protocol. Crashed or timed-out sessions are released back to the queue with the log tail attached; token/cost metrics are parsed from the CLI's own JSON result.

```bash
npm run dispatcher -- path/to/dispatcher.config.json
```

See `packages/dispatcher/README.md` for the config reference (workspaces, concurrency, permission mode, attempt limits).

### Run the reviewer (unattended AI review)

Beside the dispatcher, the **reviewer** turns the `in_review` column into automated first-pass review with no human in the loop. It polls for tasks that still need a review and spawns **one fresh headless engine session per task** — **codex** by default (an independent second opinion on the dispatcher's Claude work) or claude — feeding the diff (implementation) or deliverable (description/plan) on STDIN and posting an `ai-review/v1` verdict back. It is advisory: a clean doc-stage verdict auto-advances the task; findings and the implementation stage stay for the human gate.

```bash
npm run reviewer -- path/to/reviewer.config.json
```

Run it alongside the dispatcher and web server, all on the same DB. See `packages/reviewer/README.md` for the config reference (engine, model, concurrency, diff cap, attempt limits).

### Live agent status

While agents work, the **Live** view (header toggle) and each in-progress task's drawer show what's running right now — current phase, a rolling milestone feed, and so-far token counts — fed by a `report_progress` MCP tool the worker calls as it hits each milestone. It's ephemeral current-state (gone when the session ends), distinct from the durable activity log.

### Workspaces (multi-repo)

Tasks belong to **workspaces** — named git repositories where the work happens. A fresh DB has a single `default` workspace (`repoPath: "."` = the agent's working directory), so single-repo setups need zero configuration and the UI shows no workspace chrome.

To drive agents across multiple repos from one board:

1. Create a workspace in the web UI (**Workspaces** button): a slug plus the absolute repo path.
2. Create tasks in it — the task form gains a workspace picker, and the board gains a filter and badges once a second workspace exists.
3. Pin each agent's MCP server to its workspace:

```json
"env": {
  "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db",
  "AGENTFACTORY_WORKSPACE": "shopfloor"
}
```

A pinned worker only ever claims its own workspace's tasks. The claimed payload carries `repoPath`, and the agent creates its per-task worktree under `<repoPath>/.worktrees/<key>`. See `packages/mcp/README.md` for details, including the unpinned "roaming" mode.

### Stranded claims

Every claim records who took it and when (workers identify via `AGENTFACTORY_WORKER`, defaulting to the workspace pin), shown on In Progress cards. If a worker dies mid-task, open the task and hit **Release claim** — it re-queues with full history preserved, so the next claimant picks up exactly where the dead one left off.

### Reviewing changes (diff view)

When a worker submits a result with a `branch` link (the convention: `feature/<key>-<kebab-title>`), the task's detail panel shows a **Changes** section — files changed and +/− counts — and a **View diff** button that opens the full per-file, line-level diff right on the board. The diff is computed live from the workspace repo (merge-base against the default branch), so commits that landed on main after the branch point never pollute the review. Approve or request changes without leaving the board.

### AI first-pass review (advisory)

A reviewer can examine each `in_review` task's diff (implementation) or deliverable (description/plan) and post its findings back as a comment using the **`ai-review/v1` marker convention** (marker line + summary + fenced JSON: `{ reviewer, verdict, findings }` — see `docs/superpowers/specs/2026-06-12-ai-review-tier.md`). The board surfaces the verdict as a chip on the card (**clean** / **N findings** / **pending** after a resubmission), renders the findings as a checklist in the drawer, and **Request changes** composes the checked findings plus your own note into one attributed feedback body. Uncurated findings never reach the implementing agent — MCP payloads strip ai-review comments; only your curated feedback rides the re-claim. Approving past open findings stays one confirm away and is logged as an override.

The board itself never runs the engine — a supervisor posts the verdict, and two are interchangeable: the in-repo **`reviewer`** supervisor (`npm run reviewer`, default engine **codex** — see [Run the reviewer](#run-the-reviewer-unattended-ai-review) above), or, outside this repo, `Run-ReviewerLoop.ps1` (`-Reviewer claude|codex`) in the **ado-bridge** repo (the third of its loops beside the `Run-AdoBridgeLoop.ps1` producer and the `Run-AgentFactoryLoop.ps1` worker). A clean verdict on a **doc stage** auto-advances the task to its next stage; **findings** and the **implementation** stage escalate to the human gate.

### The PR loop (push, clean up, reopen)

Workers start every task by creating a worktree on its feature branch (`feature/<key>-<kebab-title>`) **based on the latest default branch** — the server resolves the base (`origin/main`, fetched first) so work always begins from current main, not whatever the repo happened to have checked out. They finish by pushing that branch to `origin` and removing the worktree before `submit_result` — the branch is the durable record, and nothing piles up on disk. You review on the board, approve, and open the PR manually from the already-pushed branch (GitHub, Azure DevOps — anything on the remote). If the PR build fails, paste the failure as a comment on the task and hit **Reopen** (done → queued): the next claimant gets the full thread, continues on the same branch, and its push updates the same PR. Tip: enable *delete branch on merge* so merged feature branches clean themselves up.

### Images in specs

Paste screenshots straight into the task form (Ctrl+V) while writing or editing a backlog task — they're downscaled client-side (max 1568px long edge, the model's effective resolution), stored in the shared SQLite, and shown as thumbnails on the task. When an agent claims the task, the images arrive in the MCP payload as **image content blocks**, so the agent sees the actual pixels alongside the spec. Attachments are frozen once a task is queued (the brief doesn't change mid-flight) and are deleted with the task.

### Analytics

The third view in the header toggle (**Board · List · Analytics**) answers "how is my agent loop performing?" — tasks done, median cycle/work time, first-pass approval rate, reopen rate, AI override rate (approvals past open review findings), where time goes per stage (in practice: the human review queue, not the agents), daily throughput, review round-trip distribution, tokens by model or by workspace (toggle), and a per-worker table with stranded-release counts. Everything timing/quality is derived from the activity log, so it works retroactively for every task ever; tokens and cost are **worker-reported** (optional `metrics` on `submit_result`, or `POST /api/tasks/<key>/metrics` from a loop wrapper with exact usage) and unreported tasks show *n/a* — never zero. Each task's drawer also gets a **Metrics** strip: stage timeline plus rounds/tokens/cost chips. Filter by workspace and 7d/30d/all.

### Token telemetry (OpenTelemetry)

Token usage is captured per task even for **interactive/streamed** sessions and **Codex** — the modes the dispatcher's stdout parse can't see. The web server hosts an **OTLP/HTTP (JSON) logs receiver at `POST /v1/logs`**; point either CLI's native OpenTelemetry export at it with the task key set, and the receiver sums tokens into the same `task_metric` rows analytics reads. The dispatcher wires this automatically when its config has an `otel` block (and then skips its stdout parse to avoid double-counting). See [`docs/token-telemetry.md`](docs/token-telemetry.md) for the Claude env vars, the Codex `config.toml`, and the limitations.

### Deleting tasks

Open a task and use **Delete task** at the bottom of the drawer (it arms into a red *Confirm delete?* — second click deletes). The task and its whole activity/link history are gone for good; there is no archive. In-progress tasks are protected: release the claim first, then delete. Deletion is human-only — agents have no delete tool.

### Run tests

```bash
npm test
```
