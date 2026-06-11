# AgentFactory

AgentFactory: a single-user local task board that is the persistent state store + UI for an external agent loop.

## Stack

TypeScript monorepo (npm workspaces) with three packages:

- **`core`** — node:sqlite + lifecycle rules (shared business logic and DB layer)
- **`mcp`** — stdio MCP server (exposes task board operations to agent loops)
- **`web`** — Hono API + SSE + React/Vite UI (browser-based task board interface)

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

When a worker submits a result with a `branch` link (the convention: branch `task/<key>`), the task's detail panel shows a **Changes** section — files changed and +/− counts — and a **View diff** button that opens the full per-file, line-level diff right on the board. The diff is computed live from the workspace repo (merge-base against the default branch), so commits that landed on main after the branch point never pollute the review. Approve or request changes without leaving the board.

### The PR loop (push, clean up, reopen)

Workers finish every task by pushing `task/<key>` to `origin` and removing their worktree before `submit_result` — the branch is the durable record, and nothing piles up on disk. You review on the board, approve, and open the PR manually from the already-pushed branch. If the PR build fails, paste the failure as a comment on the task and hit **Reopen** (done → queued): the next claimant gets the full thread, continues on the same branch, and its push updates the same PR. Tip: enable GitHub's *delete branch on merge* so merged task branches clean themselves up.

### Analytics

The third view in the header toggle (**Board · List · Analytics**) answers "how is my agent loop performing?" — tasks done, median cycle/work time, first-pass approval rate, reopen rate, where time goes per stage (in practice: the human review queue, not the agents), daily throughput, review round-trip distribution, tokens by model, and a per-worker table with stranded-release counts. Everything timing/quality is derived from the activity log, so it works retroactively for every task ever; tokens and cost are **worker-reported** (optional `metrics` on `submit_result`, or `POST /api/tasks/<key>/metrics` from a loop wrapper with exact usage) and unreported tasks show *n/a* — never zero. Each task's drawer also gets a **Metrics** strip: stage timeline plus rounds/tokens/cost chips. Filter by workspace and 7d/30d/all.

### Deleting tasks

Open a task and use **Delete task** at the bottom of the drawer (it arms into a red *Confirm delete?* — second click deletes). The task and its whole activity/link history are gone for good; there is no archive. In-progress tasks are protected: release the claim first, then delete. Deletion is human-only — agents have no delete tool.

### Run tests

```bash
npm test
```
