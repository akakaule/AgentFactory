# Token telemetry — per-task usage via OpenTelemetry (Claude + Codex)

AgentFactory captures token usage from agent runs and rolls it up per task (the task **Metrics**
strip + Analytics). The dispatcher's stdout parse only sees **headless** `claude -p` runs, so
**interactive** sessions and **Codex** were blind spots. This wires both CLIs' native
OpenTelemetry export into AgentFactory so usage is captured **regardless of mode**.

## How it works
The web server hosts an **OTLP/HTTP (JSON) logs receiver at `POST /v1/logs`**. Both CLIs export
token-bearing log events there; the receiver reads them, sums tokens, and writes a `task_metric`
row via the normal path — so OTel usage aggregates exactly like dispatcher-reported usage.

- **Token events read:** Claude `claude_code.api_request` (`input_tokens`, `output_tokens`,
  `cache_read_tokens`, `cache_creation_tokens`, `cost_usd`, `model`); Codex `codex.sse_event` /
  `response.completed` (`input_token_count`, `output_token_count`, `cached_token_count`, `model`
  — the codex 0.14x shape, verified against 0.147.0).
- **Claude: tokensIn = input + cache_read + cache_creation** (same convention as the dispatcher's
  parser). **Codex: tokensIn = input_token_count** as-is — it already includes the cached prefix
  (OpenAI usage semantics), so cached is a breakdown, never an addend.
- **Task correlation (first match wins):** `X-Task-Key` request header → `task.key` resource
  attribute → `task.key` log attribute. **No key ⇒ the event is dropped** (per-task tracking
  needs a task binding — see Limitations).
- **Auth:** `/v1/*` is behind the normal guard. In `AUTH_MODE=token`, send a **service token** in
  the OTLP `Authorization` header; in `none` mode it's open.

## Live telemetry feed
Alongside the durable per-task rollup, the receiver pushes each **task-attributed** event into a
small in-memory ring, surfaced by the **Telemetry** view (header toggle) and `GET /api/telemetry`.
It's a live table of recent events — **time · task · workspace · worker · agent · model · tokens
in · cached · out · cost** — plus rolling totals broken down by agent and model. Use it to watch
usage flow in real time and to confirm a session is actually exporting.

- **Cached** is the cache-hit portion (`cache_read + cache_creation` for Claude,
  `cached_token_count` for Codex) and is **already counted inside In** — it's a breakdown, not an
  extra addend.
- **Worker/workspace** come from the `af.worker` / `af.workspace` resource attributes the dispatcher
  stamps (see below); columns show `–` when a session doesn't set them.
- **Unattributed events** (no task key) are **dropped** — the feed shows only usage that maps to a
  task, matching the per-task rollup.
- The feed is **ephemeral** (last ~500 events, in the web-server process) and **lost on restart** —
  it's a live monitor, not history. The durable rollup (task **Metrics** + Analytics) is untouched.

## Claude Code
Set these in the environment of the `claude` process (interactive or headless):
```sh
export CLAUDE_CODE_ENABLE_TELEMETRY=1
export OTEL_LOGS_EXPORTER=otlp
export OTEL_EXPORTER_OTLP_PROTOCOL=http/json
export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8787          # the AgentFactory web server
export OTEL_EXPORTER_OTLP_HEADERS="Authorization=Bearer <service-token>"   # only in token mode
export OTEL_RESOURCE_ATTRIBUTES="task.key=AF-123"                # bind this session to a task
claude            # or: claude -p ...
```
The **dispatcher does this automatically per session** when its config has an `otel` block — it
stamps `task.key`/`af.workspace`/`af.worker` and, importantly, **stops parsing stdout for metrics**
so the session isn't double-counted:
```jsonc
// dispatcher.config.json
{ "otel": { "endpoint": "http://localhost:8787", "token": "<service-token>" } }
```

## Codex
Two codex behaviors shape the wiring (both verified against codex 0.147.0):
- Codex uses the configured OTLP endpoint **verbatim** — it never appends `/v1/logs`, so the
  endpoint must carry the full path.
- Codex does **not interpolate env vars** into config header values — a
  `"X-Task-Key" = "${AF_TASK_KEY}"` header arrives as the literal string `${AF_TASK_KEY}`, so a
  static `~/.codex/config.toml` cannot bind a run to a task.

The **reviewer therefore injects the whole exporter per spawn** when its config has an `otel`
block, as a config override on the codex command line (for the `claude` engine it stamps the full
OTLP env + a `task.key` resource attribute instead, like the dispatcher):
```jsonc
// reviewer.config.json
{ "otel": { "endpoint": "http://localhost:8787", "token": "<service-token>" } }
```
becomes, per review/visualization session:
```
codex exec ... -c otel.exporter={otlp-http={endpoint="http://localhost:8787/v1/logs",protocol="json",headers={X-Task-Key="AF-123",Authorization="Bearer <service-token>"}}}
```
No `[otel]` block in `~/.codex/config.toml` is needed (an existing one is overridden for these
spawns and can be removed). For a **manual** task-bound run, pass the same `-c` override with the
task key inlined. Token counts ride `codex.sse_event` logs in both interactive and `codex exec`
(note: `codex exec` emits logs but no OTel *metrics* — we read logs, so this is fine).

## Verify
```sh
# 1. start the server (none mode for a quick local check)
npm run web
# 2. run Claude interactively, bound to a real queued task, and do a turn:
CLAUDE_CODE_ENABLE_TELEMETRY=1 OTEL_LOGS_EXPORTER=otlp OTEL_EXPORTER_OTLP_PROTOCOL=http/json \
  OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:8787 OTEL_RESOURCE_ATTRIBUTES=task.key=AF-1 claude
# 3. open AF-1 on the board — the Metrics strip should rise as turns happen.
```

## Limitations
- **Ad-hoc interactive sessions not bound to a task** (no `task.key`/`X-Task-Key`) still export,
  but are **dropped** — they appear neither in the per-task rollup nor in the live **Telemetry**
  feed (both show only task-attributed usage). Per-task attribution requires the session to carry a
  task key (the dispatcher's and reviewer's `otel` blocks set it automatically; for an
  interactive worktree session or a manual `claude`, set `OTEL_RESOURCE_ATTRIBUTES=task.key=…`
  in the environment).
- **Logs only, into `task_metric`** — no separate metrics pipeline/Grafana. A standalone OTel
  Collector can be added later by pointing the same env/config at it instead (or as well).
- **OTLP/JSON only** (`http/json`) — protobuf isn't parsed; both CLIs support JSON.
