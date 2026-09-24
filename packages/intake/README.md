# Intake supervisor

The optional intake supervisor polls opted-in code tasks, asks the configured provider for the
versioned intake decisions, and publishes only validated `intake/v1` activity markers. It is safe
to leave the process stopped or configure `mode: "off"`; no provider request is made unless the
board settings explicitly opt a workspace into advisory mode.

Configuration uses exactly one of `db` or `board`:

```json
{
  "db": "./agentfactory.db",
  "pollSeconds": 30,
  "provider": {
    "name": "fixture"
  }
}
```

For Jev, use a pinned model and an environment variable name for the API key. The key and provider
response bodies are never written to the board or production logs. Advisory mode currently shares
the board's plain service-token capability; stronger assessment-writer authorization is required
before any enforcement proposal.

Example Jev configuration:

```json
{
  "board": { "url": "http://127.0.0.1:3000", "tokenEnv": "AGENTFACTORY_INTAKE_TOKEN" },
  "provider": {
    "name": "jev",
    "endpoint": "https://api.typesafe.ai/v1/systemone",
    "apiKeyEnv": "TYPESAFE_API_KEY",
    "model": "jev-1.13.0"
  }
}
```

The adapter was checked against https://docs.typesafe.ai/api.md and
https://docs.typesafe.ai/models.md on 2026-09-20. Questions use typed `noul`/`choice`
objects; readiness reads the returned `noul` number. A controlled synthetic request
to the real endpoint succeeded with `jev-1.13.0`, all five decisions, and reported
usage (569 input / 158 output tokens), and passed core assessment validation.

The board applies migration 26, which widens the heartbeat kind check to include
`intake` and preserves existing heartbeat rows. Start the board and verify an authenticated
`GET /api/agent/whoami` before starting intake in board mode.

Configure `intake.config.json` in the repository root (ignored by Git). Store the
provider key and board service token in the environment named by `apiKeyEnv` and
`board.tokenEnv`, then run `npm run intake -- intake.config.json`. On Windows,
existing terminals do not automatically receive newly saved user environment variables;
open a new terminal or load them explicitly into the launching process.

Use the board's Task Intelligence settings to select Advisory mode and explicitly
opt in workspaces. Workspace policy text is sent only when the live setting permits it.
