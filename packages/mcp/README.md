# @agentfactory/mcp

A stdio MCP server that exposes the AgentFactory task board to an agent runtime.

## What it is

This package implements the [Model Context Protocol](https://modelcontextprotocol.io/) server for AgentFactory. It gives an AI agent (e.g. Claude Code, Claude Desktop) read/write access to the task board through 6 tools:

| Tool | Description |
|---|---|
| `list_tasks` | List tasks, optionally filtered by status |
| `get_next_task` | Claim and return the next available task (status: `todo`) |
| `get_task` | Get a single task by key |
| `add_comment` | Add a comment to a task |
| `submit_result` | Submit a result for a completed task |
| `update_status` | Transition a task to a new status |

**Task creation is human-only** — tasks are created via the web UI. The agent only consumes and progresses work items.

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
