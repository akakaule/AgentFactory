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

### Run tests

```bash
npm test
```
