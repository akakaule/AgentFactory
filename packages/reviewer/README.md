# @agentfactory/reviewer

A small Node supervisor that runs AgentFactory's **AI first-pass review** with **no human in
the loop**. It polls the DB for `in_review` tasks that still need a review and spawns **one
fresh headless engine session per task** — codex (default) or claude — feeding it the task's
diff (implementation) or deliverable (description/plan) on STDIN, then posts the engine's
`ai-review/v1` verdict back as a comment.

It is the in-repo sibling of the [dispatcher](../dispatcher/README.md): the same poll → spawn →
reap shape, Core-direct (opens the same SQLite DB), no web server required. It supersedes the
ado-bridge `Run-ReviewerLoop.ps1` for in-repo use.

Born of the AI review tier in
[`docs/superpowers/specs/2026-06-12-ai-review-tier.md`](../../docs/superpowers/specs/2026-06-12-ai-review-tier.md)
and the supervisor design in
[`docs/superpowers/specs/2026-06-15-reviewer-supervisor-design.md`](../../docs/superpowers/specs/2026-06-15-reviewer-supervisor-design.md).

## Advisory only — the board does the rest

The reviewer **only posts a verdict**; it never approves, requests changes, or moves a task.
The leverage is the board's existing `add_comment` hook: a **clean verdict on a doc stage**
(description/plan) **auto-advances** the task to its next stage, while **findings** and the
**implementation** stage stay `in_review` for the human gate (the curated-findings flow is
unchanged). So review is a pure function — read the task, run the engine, post the marker.

- **codex** (default) — an independent second opinion on the (typically Claude) dispatcher's
  work: `codex exec --sandbox read-only --skip-git-repo-check --output-last-message <file> -`.
- **claude** — `claude -p --output-format text --max-turns 1`.

Both run headless in a neutral directory (no repo `.claude/` context, no MCP), read the prompt
from STDIN (diffs are large/arbitrary), and produce the verdict text — codex via its captured
final message, claude via stdout. The `ai-review/v1` marker is prepended if the engine omits it.

## Run

```sh
npm run build                            # from the monorepo root
node packages/reviewer/dist/index.js [path/to/reviewer.config.json]
# or, during development:
npm run reviewer:dev -- path/to/reviewer.config.json
```

The config path defaults to `reviewer.config.json` in the current directory. `db` and the
`logs/` directory are resolved relative to the config file. Stop with Ctrl-C — in-flight
reviews are killed.

Run it **alongside** the dispatcher (the dispatcher produces `in_review` tasks; the reviewer
reviews them) and the web server, all pointed at the same DB.

## Config (`reviewer.config.json`)

| Field | Default | Meaning |
|-------|---------|---------|
| `db` | — (required) | Path to the agentfactory sqlite DB. |
| `workspaces` | — (optional) | Workspace slugs to watch. **Omit to watch every workspace in the DB** (opt-out model) — the list is re-read each tick, so a workspace created on the board is reviewed automatically, with no config edit and no restart. When present, pins the reviewer to exactly these slugs (opt-in back-compat). |
| `excludeWorkspaces` | `[]` | Workspace slugs to **never** watch — the opt-out escape hatch. Applied whether or not `workspaces` is set. |
| `engine` | `codex` | Review engine: `codex` or `claude`. |
| `model` | — (optional) | Model override (codex `-m`, claude `--model`). |
| `pollSeconds` | `60` | Queue poll interval. |
| `maxConcurrent` | `1` | Max concurrent reviews **per workspace**. |
| `reviewMinutes` | `10` | Hard wall-clock cap; the supervisor kills a review that exceeds it (counts as an attempt). |
| `maxDiffChars` | `120000` | The diff is truncated to this many chars before the prompt (0 = no limit). |
| `maxAttempts` | `2` | Attempts a task gets before it is skip-listed and left for a human reviewer. |

See [`reviewer.config.example.json`](./reviewer.config.example.json).

## Which tasks it reviews

Each poll lists `in_review` tasks per workspace and keeps those that **need a review** —
`task.aiReview` is absent, or its verdict is `pending` (a newer result superseded the last
review). A task with a current `clean`/`findings` verdict is skipped, so the reviewer never
re-reviews settled work and never races itself.

## Engine setup

- **codex**: install the Codex CLI on PATH (or set `AGENTFACTORY_CODEX_BIN` to its path). The
  review runs read-only against the diff text, so it needs no checkout of the target repo.
- **claude**: the Claude CLI on PATH (or `AGENTFACTORY_CLAUDE_BIN`).

To attribute review token usage per task, point the engine's OpenTelemetry export at the web
server's `/v1/logs` receiver with `task.key` set — see [`docs/token-telemetry.md`](../../docs/token-telemetry.md).

## What the supervisor does

- **Spawns** the engine with the per-stage review prompt on STDIN, cwd = `logs/` (neutral),
  one session per task labelled `<ws>#<key>-r<attempt>`.
- **Reaps** each exit: reads the verdict (codex output file / claude stdout), ensures the
  `ai-review/v1` marker, and posts it via `add_comment` (actor `agent`). A clean doc-stage
  verdict auto-advances; everything else stays `in_review`.
- **Fails quietly** (advisory): a timeout, crash, or empty verdict posts **nothing**, burns an
  attempt, and skip-lists after `maxAttempts` — the task simply waits for a human reviewer.
- **Logs** every review to `logs/<key>-review-<n>.log` (engine stdout + stderr); codex's
  captured verdict also lands in `logs/<key>-review-<n>.out`.

In-memory attempt counters reset on reviewer restart (acceptable v1).
