# Recovering task worktrees in headless workers

AF-146 could neither inspect its preserved worktree nor merge a newer default branch:
its shell Git commands required unavailable approval, and task_git lacked those actions.

Extend the existing task-scoped MCP broker rather than broadening shell permissions.
The active implementation owner can request status, diff, log, merge_default, and
continue_merge. The broker derives the repository, worktree, branch and remote from
the assigned task. Check claim ownership before each Git subprocess. Preserve the
existing branch, repository and symlink checks and disable Git hooks.

Inspection reports tracked/untracked changes, staged/working/branch diffs, recent
commits, merge state and divergence from the last fetched default branch. A clean
merge fetches origin, resolves its default branch to an immutable commit, then merges
without rebasing. Dirty work is refused, never automatically stashed or discarded.
Conflicts remain in place for ordinary file edits. Repeated preparation and merge
requests preserve the interrupted merge. Continue checks conflict markers before
staging and committing. Publishing and cleanup reject unfinished merges; no force
push is available.

Reclaim instructions require inspection and reconciliation before verification.
A missing review is not new code feedback. Keep malformed reviewer output as a
bounded execution failure with the submitted result in review. Correct JSON fence
extraction in discovery and consensus so backticks inside findings cannot truncate
an otherwise valid response.

Verify with real temporary repositories, reviewer lifecycle regressions, a production
build, and an isolated headless Claude session resolving a real merge conflict.
