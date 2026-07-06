# AgentFactory Memory

- Delivery watcher pattern: when a git-host PR is open but cannot be completed for a host-reported reason such as merge conflicts, do not leave the task in `delivering` and do not hide it under generic CI failure. Add a specific `failure/v1` reason, bounce to `queued`, and include same-branch repair instructions so the dispatcher reclaims the persisted branch and updates the existing PR.
