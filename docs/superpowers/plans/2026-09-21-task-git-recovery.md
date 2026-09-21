# Task Git recovery

Implement the accepted proposal: pinned implementation workers can inspect their worktree,
merge the fetched default branch, resolve conflicts with normal file edits, and finish the
merge without shell Git permission prompts. Keep ownership/path checks, preserve dirty
work, and prohibit publishing or cleanup during unfinished merges. No force push/rebase.

1. Add real-repository MCP regressions for inspection, dirty refusal, conflicting merge,
   interrupted recovery, normal push, and lost ownership.
2. Add status/diff/log/merge_default/continue_merge actions with structured responses.
3. Update managed worker instructions; verification is required after reconciliation.
4. Inspect reviewer JSON failure evidence; fix confirmed parser defects with regressions.
   Failed review execution must retain the submission and use its bounded retry budget.
5. Build, focused/full tests, client typecheck, diff check. Verify actual headless tool access
   on an isolated fixture before rolling out and requeueing AF-146.

Preserve unrelated working-tree edits. Never experiment with fault injection on live tasks.
