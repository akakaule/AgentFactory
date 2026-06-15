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
  `response.completed` (`input_tokens`, `output_tokens`, `cached_input_tokens`, `model`).
- **tokensIn = input + cache_read + cache_creation; tokensOut = output** (same convention as the
  dispatcher's parser).
- **Task correlation (first match wins):** `X-Task-Key` request header → `task.key` resource
  attribute → `task.key` log attribute. **No key ⇒ the event is dropped** (per-task tracking
  needs a task binding — see Limitations).
- **Auth:** `/v1/*` is behind the normal guard. In `AUTH_MODE=token`, send a **service token** in
  the OTLP `Authorization` header; in `none` mode it's open.

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
Codex is configured by file, not env (env only interpolates into values like headers). In
`~/.codex/config.toml`:
```toml
[otel]
exporter = "otlp-http"

[otel.exporter.otlp-http]
endpoint = "http://localhost:8787"
protocol = "json"

[otel.exporter.otlp-http.headers]
Authorization = "Bearer ${AF_OTEL_TOKEN}"   # only in token mode
X-Task-Key   = "${AF_TASK_KEY}"             # binds the run to a task
```
Then export `AF_TASK_KEY=AF-123` (and `AF_OTEL_TOKEN`) before launching `codex` / `codex exec`
(e.g. the ado-bridge reviewer loop sets these per task). Token counts ride `codex.sse_event` logs
in both interactive and `codex exec` (note: `codex exec` emits logs but no OTel *metrics* — we read
logs, so this is fine).

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
  but land **unattributed** and are dropped. Per-task attribution requires the session to carry a
  task key (the dispatcher's `otel` block sets it automatically; for the `reviewer`, an
  interactive worktree session, or a manual `claude`, set `OTEL_RESOURCE_ATTRIBUTES=task.key=…`
  in the environment).
- **Logs only, into `task_metric`** — no separate metrics pipeline/Grafana. A standalone OTel
  Collector can be added later by pointing the same env/config at it instead (or as well).
- **OTLP/JSON only** (`http/json`) — protobuf isn't parsed; both CLIs support JSON.
