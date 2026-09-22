# AF-144 delivery recovery

AF-144 was requeued for a Prettier failure just before its PR was merged. Its retry then mistook an unregistered directory recreated after cleanup for a worktree. GitHub observations stopped after the requeue.

1. Regress continued delivery observations during queued, active, blocked and review states. Keep observations separate from task transitions: only Delivering may auto-complete or bounce. Preserve human overrides, active claims, archive boundaries and delivery identity across slow provider requests. Show delivery metadata on cards and details during repair; only delivery action buttons remain status-gated. Merged labels must show the actual check result.
2. Implement the watcher/core observation fix without changing merge-plus-green completion policy or schema. Regress provider failures and repeated polls without duplicate failure comments.
3. Extend the worker finish contract to require repository CI checks (including lint, formatting and type checks) before handoff, and distinguish open PR reuse from a follow-up PR after merge.
4. Verify the existing task_git recovery with real Git and AF-144's leftover-directory shape. Preserve existing repository work and leftover files.
5. Prepare the LytEasy formatting repair in a separate local worktree based on current main; reproduce Prettier failure before formatting, then verify. Investigate any additional main CI failure before deciding whether it is related.
6. Build and test AgentFactory, refresh AF-144's delivery observation using the repaired watcher, and record the lessons in MEMORY.md. No push or PR creation is authorized in this session.

## Verification

- RED: nine watcher/core/protocol regressions failed before the fix; six UI assertions failed before exposing the delivery summary and correcting merged labels.
- GREEN: 1,358 AgentFactory tests passed with `npm test -- --maxWorkers=2 --minWorkers=1`. After the UI changes, all 261 client tests passed. Full TypeScript build, client type check and production client build passed.
- The unbounded suite hit the existing 30-second real-Git test timeout under concurrent load; the bounded run passed all seven lifecycle cases, including cleanup followed by late directory writes.
- A real watcher poll changed AF-144's delivery from open to merged while preserving its blocked status and activity history.
- LytEasy's two formatting failures reproduced on main, then passed after Prettier. All web lint/type/format checks, 462 tests (two fixture skips) and build passed. Repair is local commit `c710e67` on `fix/af-144-ci-verification` in `C:/Git/LytEasy/.worktrees/af-144-ci-repair`.
- Separate main CI failure: run 34841841665 failed in `ElevenLabs_without_an_api_key_fails_at_startup` with `ObjectDisposedException` from ASP.NET's `DeferredHost.StartAsync`, where the test expected `OptionsValidationException`. This repair does not claim to resolve that separate test-host failure or make remote CI green.
