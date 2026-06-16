# @agentfactory/mcp

A stdio MCP server that exposes the AgentFactory task board to an agent runtime.

## What it is

This package implements the [Model Context Protocol](https://modelcontextprotocol.io/) server for AgentFactory. It gives an AI agent (e.g. Claude Code, Claude Desktop) read/write access to the task board through 6 tools:

| Tool | Description |
|---|---|
| `list_tasks` | List tasks, optionally filtered by status and/or workspace |
| `get_next_task` | Claim and return the next available task (status: `queued`), optionally scoped to a workspace |
| `get_task` | Get a single task by key |
| `add_comment` | Add a comment to a task |
| `submit_result` | Submit a result for a completed task |
| `update_status` | Transition a task to a new status |

**Task creation is human-only** — tasks are created via the web UI. The agent only consumes and progresses work items.

## Workspaces

Every task belongs to a **workspace** — a named git repository (or any working directory) where its work happens. The claimed task's payload carries `workspace` (the slug) and `repoPath`. The seeded `default` workspace has `repoPath: "."`, meaning "the agent's current working directory" — exactly the single-repo behavior from before workspaces existed.

**Worker-per-workspace (recommended):** pin the server to one workspace via the `AGENTFACTORY_WORKSPACE` env var. `get_next_task` and `list_tasks` then default to that workspace when the `workspace` param is omitted, so a worker launched for repo A can never accidentally claim repo-B work. An explicit `workspace` param still overrides the pin (it is a default, not an ACL — this is a single-user tool).

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "node",
      "args": ["c:\\Git\\AgentFactory\\packages\\mcp\\dist\\index.js"],
      "env": {
        "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db",
        "AGENTFACTORY_WORKSPACE": "shopfloor"
      }
    }
  }
}
```

**Roaming worker:** leave `AGENTFACTORY_WORKSPACE` unset; claims are global FIFO across all workspaces, and the agent reads `repoPath` off each claimed task and works there. This requires the agent session to have filesystem access to every workspace's repo (e.g. `--add-dir`).

A claim or list with an unknown workspace slug fails loudly (tool error) rather than idling on an empty-looking queue — a typo'd worker config should be visible immediately. Workspace creation is human-only (web UI), like task creation.

## Claim metadata & stranded claims

Every claim records **who** (`claimed_by`) and **when** (`claimed_at`) on the task, shown on the board. The worker's identity comes from the `AGENTFACTORY_WORKER` env var, falling back to the `AGENTFACTORY_WORKSPACE` pin; with neither set, claims are anonymous but still timestamped.

If a worker dies mid-task, the task sits in In Progress with its claim age visible. A human releases it from the web UI (**Release claim**, `in_progress → queued`) — the claim is cleared, all activity history is preserved, and the next claimant picks it up with full context. Agents cannot release claims.

The same rescue shape covers failed PR builds: a human comments the CI failure on the done task and **reopens** it (`done → queued`, web UI). The next claimant sees the whole thread, continues on the existing feature branch, and its push updates the same PR. Agents cannot reopen tasks.

## Worktree convention

When the agent claims a task it creates a dedicated git worktree **under the task's workspace repository** before touching any code, on a conventional **feature branch** (`feature/<key>-<kebab-title>` — PR-host friendly, e.g. Azure DevOps branch folders), **based on the latest default branch**, and does all work inside it:

```sh
git fetch origin
git worktree add <repoPath>/.worktrees/AF-12 -b feature/AF-12-barcode-scanner-intake-form origin/main
```

The base is resolved by the server per repo (`origin/<default>` via `origin/HEAD`, else local `main`/`master`) and the worker fetches first, so every task starts from **current main** rather than whatever the repo happened to have checked out — the same base the board's diff is measured against. With no `origin` it bases on the local default branch (no fetch); if no default branch can be determined at all it falls back to the current `HEAD` (legacy behavior), never blocking the claim.

`<kebab-title>` = the task title lowercased, every run of non-alphanumerics replaced by `-`, edge dashes trimmed, truncated to 40 characters. The name is deterministic from the claimed payload, so a re-claim derives the same branch.

If the branch already exists — the task came back via review feedback or a reopen — the worktree is added **from** it instead (no `-b`), so work continues on the same branch and pushes update the same PR:

```sh
git worktree add <repoPath>/.worktrees/AF-12 feature/AF-12-barcode-scanner-intake-form
```

When `repoPath` is `.`, resolve it against the agent's current working directory. One task = one worktree = one branch; parallel agents never collide because each task is isolated in its own checkout. Add `.worktrees/` to the target repo's `.gitignore`.

**Finish protocol** — before calling `submit_result`, the worker leaves nothing behind:

```sh
git -C <worktree> push -u origin feature/AF-12-barcode-scanner-intake-form   # the branch is the durable record
git worktree remove <repoPath>/.worktrees/AF-12   # refuses on uncommitted changes
git worktree prune
```

then submits with a `branch` link (label = the branch name) plus a PR link if one exists. The board's diff view reads the *branch*, so review needs nothing from the worktree — and the human can open a PR from the pushed branch at any time (GitHub, Azure DevOps, anything with the remote).

The convention is embedded in the `get_next_task` and `submit_result` tool descriptions, so any MCP agent runtime picks it up without extra prompting.

## Usage metrics (optional)

The board's analytics can track tokens/cost per task. Two capture paths:

1. **Best-effort at submit** — `submit_result` accepts an optional `metrics` object (`{ model, tokensIn, tokensOut, costUsd }`). Interactive agents rarely know exact usage; estimates are fine, omissions are fine.
2. **Exact, post-run** — a loop wrapper that runs `claude -p --output-format json` gets precise usage and cost in the result envelope *after* the session ends, and can `POST /api/tasks/<key>/metrics` on the web API (same fields plus `reportedBy`).

Reports accumulate per task (a re-submission after feedback adds usage); an unreported task shows **n/a** on the board — never zero.

## Build

Build core first (the mcp package depends on it), then mcp:

```sh
npm -w packages/core run build && npm -w packages/mcp run build
```

The entry point lands at `packages/mcp/dist/index.js`.

## Shared-DB contract

Both the MCP server (agent process) and the web app read and write the **same SQLite file**. That file is the only channel between the two sides. Set the `AGENTFACTORY_DB` environment variable to the absolute path of that file in both processes.

```
AGENTFACTORY_DB=c:\Git\AgentFactory\agentfactory.db
```

If `AGENTFACTORY_DB` is not set, the server defaults to `./agentfactory.db` relative to the working directory — which is rarely what you want in production.

## MCP client configuration

### Production (compiled)

Add to your MCP client config (e.g. `claude_desktop_config.json` or `.claude/mcp.json`):

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "node",
      "args": ["c:\\Git\\AgentFactory\\packages\\mcp\\dist\\index.js"],
      "env": { "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db" }
    }
  }
}
```

### Development (tsx, no build step)

```json
{
  "mcpServers": {
    "agentfactory": {
      "command": "npx",
      "args": ["tsx", "c:\\Git\\AgentFactory\\packages\\mcp\\src\\index.ts"],
      "env": { "AGENTFACTORY_DB": "c:\\Git\\AgentFactory\\agentfactory.db" }
    }
  }
}
```

The dev form runs the TypeScript source directly via `tsx` — useful during active development without a watch build.
