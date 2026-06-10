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

## Worktree convention

When the agent claims a task it creates a dedicated git worktree **under the task's workspace repository** before touching any code, and does all work inside it:

```sh
git worktree add <repoPath>/.worktrees/AF-7 -b task/AF-7
```

When `repoPath` is `.`, resolve it against the agent's current working directory. One task = one worktree = one branch (`task/<key>`). The worktree and branch are recorded on the task via `submit_result` links (kinds `worktree` and `branch`) so the reviewer can find the work, and parallel agents never collide because each task is isolated in its own checkout. Add `.worktrees/` to the target repo's `.gitignore`.

The convention is embedded in the `get_next_task` and `submit_result` tool descriptions, so any MCP agent runtime picks it up without extra prompting.

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
