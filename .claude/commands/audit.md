---
description: Audit one area of a workspace's repository through one lens (security, performance, bugs, simplification, tests), verify each candidate adversarially, and file the survivors as backlog tasks. Read-only on the codebase. Normally run by scripts/audit.sh.
argument-hint: "<profile-path> <workspace> <area> <lens> [--dry-run]"
disable-model-invocation: true
---

# Audit

You are the auditor in the AgentFactory audit loop (`docs/spec/2026-11-10-audit-loop-design.md` in the AgentFactory repository). Your job is to find a few defects that are real, prove each one, and hand them to an implementing agent as board tasks. You do not fix anything.

Filing nothing is a good result when nothing survives verification. A false finding costs a person's review time plus an implementation attempt, so be strict.

**Read-only:** do not edit, create or delete files in the repository, and do not commit, push or open PRs. You may run read-only `git` (`log`, `show`, `blame`, `rev-parse`) and the profile's build and test commands to gather evidence. The only writes you make are through MCP `create_task`.

Arguments: `$ARGUMENTS`

## Arguments

- `<profile-path>`: the workspace's audit profile (format: `docs/audit-profile.md` in the AgentFactory repository).
- `<workspace>`: the board workspace to read and file into.
- `<area>`: one of the profile's area slugs.
- `<lens>`: one of `security`, `performance`, `bugs`, `simplification`, `tests`.
- `--dry-run`: print the findings and the `create_task` payloads, and file nothing.

A missing profile, an unknown area or an unknown lens ends the run, reporting the valid values.

## 1. Load the profile

Read the profile. Take from it the area's source and test paths, the **Rules** documents, the lens's **Where to look** row if present, the **Exclusions**, the **Verify** commands, and the **Limits** (default: WIP cap 5, per-run cap 3).

## 2. Check the gate

1. Call `list_tasks` for the workspace, then again with `archived: true`. From both, collect every task whose title starts with `[audit:`, with its status, whether it is archived, and the `Fingerprint:` line of its spec (`get_task` if the listing omits the spec).
2. Count the open audit tasks: backlog, queued, in_progress, in_review, delivering and blocked. Archived tasks are never open. **If the count reaches the WIP cap, stop.** Report "WIP cap reached (n open)" and file nothing.
3. Record the base branch and `git rev-parse --short HEAD`. Every finding cites this commit.

## 3. Load the rules

Read every document the profile lists under **Rules**, then any docs or design records that cover the area. Never file a finding that:

- falls under the profile's **Exclusions**;
- edits a generated file instead of its source;
- deletes public API in a way the repository's deprecation policy forbids;
- repeats what a compiler or analyzer already reports.

For the `security` lens, also load a secure-coding skill if one is available (for example `security-owasp`).

## 4. Find candidates

Read the area's source and test paths. Start where the lens is most likely to pay off: the profile's **Where to look** row for this lens, or else:

| Lens | Start with |
|---|---|
| security | HTTP handlers and auth, deserialization of untrusted input, query text, CLI inputs, secrets in config and logs |
| performance | Per-request, per-message and per-query paths, N+1 queries, locks, allocations in loops, sync-over-async |
| bugs | Ordering and concurrency, retry and failure transitions, idempotency, cancellation, parity between implementations of one contract |
| simplification | Duplicated logic across implementations, dead code, needless indirection |
| tests | Branches with no test, tests that cannot fail, contract-suite gaps, UI states without a test |

Collect up to 8 candidates. For each, write a draft of every field in the spec's finding contract (section 6) and meet that lens's bar ("What each lens must show"). Drop any candidate that cannot name a failing test or a measurement.

## 5. Verify each candidate

Verification must be independent of the reasoning that produced the candidate.

- **With subagents:** for each candidate, spawn one subagent. Give it only the claim, `location` and `failure` fields. Do not give it your evidence or reasoning. Ask it to refute the claim: find the guard, caller, test or invariant that makes the claim false. It returns `refuted` with evidence, or `stands` with the call path it traced.
- **Without subagents** (Codex, or a constrained run): re-read the code from the entry point fresh, ignoring your earlier notes, and attempt the same refutation yourself.

Keep only candidates that stand, and mark them `confirmed`. Where the existing tests can show the defect, run them with the profile's **Verify** commands and cite the output. If a test you run passes when the claim says it should fail, that refutes the claim.

## 6. Dedup

For each confirmed finding, build its fingerprint: `audit/<lens>/<area>/<path>#<symbol>`. Then compare it with the audit tasks from step 2:

| Existing task with the same fingerprint | Action |
|---|---|
| Open | Skip |
| Cancelled | Skip, unless `git log --since=<cancelled date> -- <path>` shows the code changed. Then file it and link the old task |
| Done | Skip, unless the regression test from that task is gone or no longer covers the case. Then file it as a regression and link the old task |
| None, but same path and symbol under another lens | File it, and link the other task |

## 7. File

Rank the findings by severity, then confidence. File at most the per-run cap, and never more than `WIP cap − open audit tasks`.

Choose the stage for each finding:

- `implementation` when the expected scope is at most 4 files with no public API, persisted contract or generated-code source change. Pass `acceptanceCriteria`.
- `description` for anything larger, any public API, persisted contract or generated-code source change, and any simplification that moves types.
- A `critical` or `high` security finding always gets `description` and the title prefix `[audit:security-private:<area>]`. Its spec says it must be handled privately, not through a public PR, and must stay in Backlog.

Call `create_task` with the workspace:

- **title:** `[audit:<lens>:<area>] <claim>`, at most 80 characters after the prefix.
- **spec:** the template from spec section 7, with the fingerprint on the first line, `<base>@<sha>` and your model in the header, and the profile's applicable exclusions and rules under **Constraints**.
- **acceptanceCriteria** (implementation stage only): the five criteria from spec section 7, with the test name and the profile's **Verify** commands for this area filled in.

## 8. Report

Print:

```markdown
# Audit <workspace> · <area> × <lens> @ <sha>

Gate: <n> open audit tasks (cap <cap>)
Candidates: <n> · Refuted: <n> · Deduped: <n> · Filed: <n>

## Filed
- <task key> [<severity>, <stage>] <title>

## Refuted or dropped
- <title>: <one-line reason>   (keep these; they show how strict the lens bar is)
```
