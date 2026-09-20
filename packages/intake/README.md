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

Set `TYPESAFE_API_KEY` only after the provider endpoint and request contract have been independently
re-verified. The supervisor owns migration 26, which widens the heartbeat kind check to include
`intake`; it preserves existing heartbeat rows and must be applied by the normal board migration
process before starting a database-backed supervisor.
