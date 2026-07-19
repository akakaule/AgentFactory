# Enforced Task Dependencies

## Goal

Let a user declare that one task depends on another through both the REST API and
the task drawer. A queued dependent must not be claimed until every prerequisite
is `done`.

For `AF-2 depends on AF-1`, the stored edge points from AF-2 to AF-1. AF-2 may be
queued immediately, but workers and the dispatcher treat it as waiting while AF-1
is not done.

## Contract

- Dependencies are directed and may cross workspaces.
- A dependency is satisfied only by `done`; an archived done task remains
  satisfied.
- The dependent task may be edited only while it is `backlog` or `queued`.
  The prerequisite may be in any status.
- Self-dependencies and direct or transitive cycles are rejected.
- Adding an existing edge and removing a missing edge are idempotent.
- Reopening a prerequisite makes queued dependents ineligible again. It does not
  interrupt a dependent that has already been claimed.
- Waiting is derived state, not the existing `blocked` lifecycle status. `blocked`
  continues to mean that an agent started work and could not proceed.
- Deleting either endpoint removes its dependency edges through foreign-key
  cascades.

## Persistence and Core API

Migration 21 adds a join table:

```sql
CREATE TABLE task_dependency (
  task_id            INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  depends_on_task_id INTEGER NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  created_at         TEXT NOT NULL,
  PRIMARY KEY (task_id, depends_on_task_id),
  CHECK (task_id <> depends_on_task_id)
);

CREATE INDEX idx_task_dependency_reverse
  ON task_dependency(depends_on_task_id);
```

Core exposes `addTaskDependency(dependentKey, dependencyKey)` and
`removeTaskDependency(dependentKey, dependencyKey)`. Each operation validates both
keys and the dependent lifecycle inside one immediate transaction. Addition uses a
recursive CTE to reject an edge when the prerequisite already reaches the
dependent. Real mutations touch the dependent's `updated_at`, preserving the
existing version/SSE mechanism.

`TaskDetail` gains `dependencies` and `dependents`, each containing compact task
references (`key`, `title`, `status`, and `workspace`). `Task` gains
`unmetDependencyCount` so list consumers can show or skip waiting work without
fetching every detail.

The atomic claim query adds a `NOT EXISTS` predicate for any prerequisite whose
status is not `done`. The dispatcher also ignores list rows with a non-zero unmet
count so it does not spawn a session that cannot claim its intended task.

## REST API

The relationship is addressed by its two task keys:

- `PUT /api/tasks/:dependentKey/dependencies/:dependencyKey` adds the edge and
  returns the dependent's updated `TaskDetail`.
- `DELETE /api/tasks/:dependentKey/dependencies/:dependencyKey` removes the edge
  and returns the dependent's updated `TaskDetail`.

Both are idempotent and return `200`. Missing task keys return `404`, self-links
return `400`, cycles return `409`, and attempting to edit a dependent outside
Backlog or Queued returns `409`.

## UI

The existing task drawer gets a Dependencies section rather than adding dependency
selection to task creation. It shows:

- **Depends on**: prerequisites, with key, title, status, and workspace.
- **Blocks**: tasks that depend on the current task.
- An inline search over all active tasks, including tasks outside the current
  workspace filter.

Rows navigate to the linked task. Add/remove controls are available only when the
dependent endpoint is Backlog or Queued. Cards and rows show `Waiting on N` when
the unmet count is non-zero. Queuing remains available so dependency chains begin
automatically as prerequisites complete. Mutation errors remain visible inline.

## Non-goals

- Dependency selection during task creation.
- Automatic status changes to or from `blocked`.
- Cancelling or rewinding already-started work when a prerequisite is reopened.
- Dependency edges for archived tasks in the active-task picker.

