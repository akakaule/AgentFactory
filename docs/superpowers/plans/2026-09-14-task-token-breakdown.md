# Task token breakdown

The task drawer currently sums all usage and retains only the last model name. Add an expandable token breakdown under Metrics, grouped by pipeline stage, agent (Codex/Claude where recorded), and model. Show input, output, total, and stage subtotals, including unknown attribution and missing counts.

Reuse the durable task_metric reports and agent_session history. Attribute stages using the same preceding-session rule as the existing analytics stage totals; explain that attribution is inferred from session timing. Never infer an agent from a model name or invent usage for unreported runs. Preserve existing aggregate totals and distinguish null counts from reported zero. No migration, telemetry rewrite, or changes to active worker behavior are needed.

1. Add failing core tests for multiple stages, agents/models, repeat reports, unknown attribution, missing counts, and sum reconciliation.
2. Add task-detail-only aggregation and a backwards-compatible optional breakdown field. Keep analytics and existing API consumers unchanged.
3. Add failing component tests, then build an accessible expandable table with stage subtotals and exact token counts. Handle old servers and usage on never-claimed tasks.
4. Run focused tests, full suite, build, and client typecheck. Inspect the rendered task drawer and verify AF-143's rows reconcile to its existing totals. Keep concurrent user changes intact.

Historical limitation: task_metric stores model and reporter, but not separate reviewer/visualizer execution identities. This view groups recorded agent engines within the pipeline stage; it must not claim a separate review/visualization breakdown that the data cannot substantiate.

Verified: five new assertions failed before implementation; 20 focused tests passed afterwards. Production build and client typecheck passed. Full suite passed with 1,368 tests across 144 files using two workers (the initial unconstrained run timed out in an existing real-Git lifecycle test). All 117 live tasks reconcile their breakdown input/output sums to their recorded totals. Inspected AF-143 in both expanded and narrow drawer layouts; the narrow table scrolls horizontally. Restarted the local web server to load the new API and client build; stopped the temporary read-only preview server.
