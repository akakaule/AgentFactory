# Merged delivery recovery

AF-144 was approved and its PR merged after a failed-check bounce, but AgentFactory kept retrying implementation. A confirmed merge of the current approved delivery completes the original task, regardless of historical check results.

## Plan

1. Add regression tests for merged delivery completion during delivery/repair, retry and claim prevention, explicit reopening, stale observations, and worker shutdown.
2. Reconcile merged deliveries inside core transactions. Preserve check evidence and completion history, end the live session, and guard raw status mutations against bypassing approval. Reject late submissions after completion.
3. Reuse reconciliation in retry/claim paths and let the watcher record and complete a merge atomically. Ensure a replacement PR or intentional reopen cannot be closed by the previous delivery.
4. Prevent dispatcher launches for known merged deliveries and terminate its active repair process tree after completion, leaving its files intact.
5. Run focused regressions, rebuild TypeScript references, and check the affected packages and HTTP adapter. Keep existing unrelated workspace edits intact. Do not push or open a PR.

## Behavior and boundaries

- Preserve actual checks and failure history; never report failed checks as green.
- Complete once, with the PR and check state in the activity trail.
- Open and closed-unmerged PRs retain repair behavior.
- Explicit reopening invalidates the old active delivery; links and activity remain historical evidence.
- No worktree deletion or automatic follow-up task/PR creation.
