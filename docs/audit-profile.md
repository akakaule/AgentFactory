# Audit profiles

An audit profile tells the [audit loop](spec/2026-11-10-audit-loop-design.md) what it needs to know about one workspace's repository: its areas, its rules and its build commands. AgentFactory knows nothing about a repository beyond what its profile says.

The runner finds the profile in this order:

1. `scripts/audit.sh … --profile <path>`.
2. `<repo>/.agents/audit-profile.md`, if the repository owns its profile.
3. `~/.config/agentfactory/audit/<workspace>.md`.

A profile kept in the repository must not mention AgentFactory or the board. Keep it about the codebase, so contributors who don't use AgentFactory can still read it.

## Sections

Use these headings. The command reads them by name.

| Section | Required | Content |
|---|---|---|
| `## Rules` | Yes | Documents to read before auditing: agent instructions, contributor guide, versioning or deprecation policy |
| `## Areas` | Yes | A table: area slug, source paths, test paths. Slugs are lowercase, with hyphens |
| `## Where to look` | No | A table: lens, the hot spots to read first in this repository |
| `## Exclusions` | Yes | Findings never to file here: non-goals, generated files and their sources, API rules, contracts that need every implementation updated together |
| `## Verify` | Yes | Build and test commands. Name the commands per area when they differ; these go into acceptance criteria verbatim |
| `## Limits` | No | `WIP cap: <n>` and `Per-run cap: <n>`. Defaults: 5 and 3 |

## Example

```markdown
# Audit profile: example-service

## Rules
- AGENTS.md
- CONTRIBUTING.md
- docs/versioning.md (deprecate public API before removing it)

## Areas
| Area | Source | Tests |
|---|---|---|
| api | src/Api | tests/Api.Tests |
| storage | src/Storage.* | tests/Storage.Tests, tests/Conformance |
| web | web/src | web/src/**/*.test.tsx |

## Where to look
| Lens | Start with |
|---|---|
| bugs | Parity between the storage providers; retry transitions in src/Api/Retry |
| security | Controllers under src/Api/Controllers and their auth policies |

## Exclusions
- Do not edit `src/Api/Generated/*.cs`; the source is `api-spec.yaml`.
- A new storage interface member must be implemented by every provider and covered by the conformance suite.
- Do not propose replacing the message transport.

## Verify
- api, storage: `dotnet build -c Release` then `dotnet test -c Release --no-build`
- web: `npm --prefix web ci`, `npm --prefix web run test:ci`, `npm --prefix web run build`

## Limits
WIP cap: 5
Per-run cap: 3
```
