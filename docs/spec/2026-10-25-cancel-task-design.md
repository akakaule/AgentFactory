# Cancel a task from any status

## Problem

You couldn't drop a task without deleting it.

- **Delete** is permanent and is refused while the task is in progress.
- **Archive** only works on done tasks.
- **Release claim** puts the task back in the queue, where it gets claimed again.

A worker, review or visualization already running on an unwanted task kept spending tokens until it finished or timed out.

## Behaviour

A human can always cancel a task. `cancelled` is a new terminal status (migration #30).

- **Reachable from every status:** backlog, queued, in_progress, in_review, blocked, delivering, done. It's human-only: agents have no `cancelled` edges, and the MCP `update_status` tool neither offers it nor touches a cancelled task.
- **Running work stops:**
  - Core settles the task's live execution and its retry attempt as `cancelled`, which refunds the attempt, and ends the live agent session and clears the claim. The worker's or reviewer's late writes (`submit_result`, `report_progress`, `task_git`, the verdict post) are refused by the execution fence.
  - On their next tick, the dispatcher kills the worker's process tree, and the reviewer kills the review, consensus-round member, visualization or feedback-evaluation. Neither posts a `failure/v1` note, spends an attempt, or skip-lists the task. Both detect a cancel even if the task was reopened before the tick: the dispatcher from its claim being followed by a cancel in the activity log, the reviewer from a cancel logged since the session started. The reviewer also stops a session whose task was deleted.
  - A worker that exits on its own after the cancel (told by `update_status`) is reaped the same way, and its reported tokens are still recorded.
- **Nothing outside the board changes:**
  - An open PR stays open. The watcher stops tracking the task: its poll filter and the merged-delivery reconciliation both exclude `cancelled`, so a later merge never resurrects it.
  - An Azure DevOps work item stays as it is, and the import's title-prefix de-duplication never re-imports it.
  - Accepted race: a cancel landing between the watcher's `getTask` and `openPr` in the same check can still open a PR. Its follow-up delivery check is then skipped on the status mismatch.
- **Reopen:**
  - A human moves a cancelled code task back to `queued`. Its leftover delivery row is dropped and it gets a fresh dispatcher retry budget.
  - A pr-review task reopens to `in_review`, since it can never be queued.
  - The reopen passes the same Task Intelligence acknowledgment as queuing from backlog: a task flagged `attention_required` needs an override first.
  - Reopening isn't counted as a "reopen" in metrics; that metric stays `done → queued`.
- **Archive:** a cancelled task archives and unarchives like a done one. The Done column's "Archive all" stays done-only.
- **Dependencies:** a cancelled prerequisite keeps blocking its dependents, which wait for `done`. A human removes the dependency to let a dependent run.
- **Metrics:** time spent cancelled accrues to no bucket, and cancelled tasks never count as done.

## UI

- **Drawer:** "Cancel task" is always offered on a task that isn't cancelled or archived, including while in progress. It takes two clicks ("Confirm cancel?"), like Delete, because it kills live work.
- **A cancelled task** shows Reopen and Archive.
- **Board:** no Cancelled column; a cancelled task leaves the board.
- **List view:** cancelled tasks sort last, labelled "Cancelled".
- **Archive view:** a Status column tells archived done tasks from cancelled ones.

## Deploy

Migration #30 sits on top of AF-148's #29. Rebuild, then restart the board (:8787), MCP sessions, and the dispatcher, reviewer and watcher together, because older builds reject the `cancelled` status.
