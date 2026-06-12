# @agentfactory/dispatcher

A small Node supervisor that turns the AgentFactory queue into throughput with **no human
in the loop**. It polls the DB for queued tasks and spawns **one fresh headless `claude`
session per task** — the session claims the task, works it to `submit_result`, and exits.

Born of the design in
[`docs/superpowers/specs/2026-06-12-dispatcher-one-session-per-task-design.md`](../../docs/superpowers/specs/2026-06-12-dispatcher-one-session-per-task-design.md).

## Why a session per task

- **Staleness immunity.** A long-lived interactive worker freezes its MCP tool
  descriptions and protocol at connect time. A fresh `claude -p` per task is always born
  with the current MCP build — the structural cure for the unpushed-branch incident.
- **Crash containment.** A dead session costs *one attempt on one task*. The dispatcher —
  which knows the session died — releases the claim with the log tail attached, instead of
  leaving the task stranded `in_progress` until a human notices.
- **Measured metrics.** Usage is parsed from the CLI's own JSON result and recorded via
  `core.addTaskMetrics` — authoritative numbers, not agent self-estimates.

The **spawned session** claims via `get_next_task`; the dispatcher never claims. N racing
sessions get N distinct tasks (DB claim atomicity) or `{ task: null }` and exit cleanly.

## Run

```sh
npm run build                              # from the monorepo root
node packages/dispatcher/dist/index.js [path/to/dispatcher.config.json]
# or, during development:
npm run dispatcher:dev -- path/to/dispatcher.config.json
```

The config path defaults to `dispatcher.config.json` in the current directory. `db` and the
`logs/` directory are resolved relative to the config file. Stop with Ctrl-C — in-flight
sessions are killed.

## Config (`dispatcher.config.json`)

| Field | Default | Meaning |
|-------|---------|---------|
| `db` | — (required) | Path to the agentfactory sqlite DB. |
| `workspaces` | — (required) | Workspace slugs to serve (≥ 1). |
| `maxConcurrent` | `1` | Max concurrent sessions **per workspace**. Same-repo parallelism is opt-in — shared local resources (test DBs, ports) make 1 the safe default. |
| `pollSeconds` | `15` | Queue poll interval. |
| `permissionMode` | `acceptEdits` | `claude --permission-mode` for unattended sessions. `bypassPermissions` is supported but for contained environments only. |
| `claudeArgs` | `[]` | Extra args appended to every `claude` invocation. |
| `maxSessionMinutes` | `60` | Hard wall-clock cap; the supervisor kills a session that exceeds it (counts as an attempt). |
| `maxAttempts` | `2` | Attempts a task gets before it is skip-listed and left queued for a human. |

See [`dispatcher.config.example.json`](./dispatcher.config.example.json).

## Permissions

Unattended sessions only get as far as the **target repo's** allowlist permits — the
session's cwd is the workspace `repoPath`, so that repo's `.claude/settings*.json` applies.
Build/test commands must be allowlisted there or the worker will stall on a permission
prompt it cannot answer.

## What the supervisor does

- **Spawns** `claude -p <worker prompt> --output-format json --permission-mode <cfg>
  --mcp-config <inline agentfactory server>`, cwd = workspace `repoPath`, env
  `AGENTFACTORY_WORKSPACE` + `AGENTFACTORY_WORKER=<ws>#<key>-a<attempt>` (the worker label,
  recorded as `claimed_by`, makes every attempt attributable on the board).
- **Reaps** each exit: parses the JSON result for measured metrics; if the task is still
  `in_progress` under that session's label (crash, non-zero exit, or timeout kill), it
  comments the log tail, releases the claim (`in_progress → queued`), and retries — up to
  `maxAttempts`, after which the task is skip-listed with a console warning.
- **Logs** every session to `logs/<key>-attempt-<n>.log` (stdout + stderr); the release
  comment quotes the tail.

In-memory attempt counters reset on dispatcher restart (acceptable v1).
