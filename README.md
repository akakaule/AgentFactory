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

### Run tests

```bash
npm test
```
