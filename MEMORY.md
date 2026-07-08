# AgentFactory Memory

- Delivery watcher pattern: when a git-host PR is open but cannot be completed for a host-reported reason such as merge conflicts, do not leave the task in `delivering` and do not hide it under generic CI failure. Add a specific `failure/v1` reason, bounce to `queued`, and include same-branch repair instructions so the dispatcher reclaims the persisted branch and updates the existing PR.
- Web modal sizing pattern: `packages/web/client/src/board.css` gives `.af-modal` a fixed `width: 560px`; larger specialized modals must override `width` directly (for example `width: min(..., 95vw)`) rather than only setting `maxWidth`.
- Schema-version test pattern: when adding a migration, update every core migration-era test that asserts the final `PRAGMA user_version`, not just the newest migration test.
