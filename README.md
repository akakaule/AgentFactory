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

```bash
npm run web:dev
```

### Run MCP server (dev mode)

```bash
npm run mcp:dev
```

### Run tests

```bash
npm test
```
