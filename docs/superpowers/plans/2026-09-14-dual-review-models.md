# Dual review model implementation

1. Add failing configuration and argv tests for ordered reviewer profiles and Codex medium reasoning. Reject invalid profiles instead of silently ignoring them.
2. Add failing supervisor tests proving both models review the same submission, no early verdict/auto-advance occurs, findings from either model survive, malformed/failing output cannot become clean, and superseded submissions are discarded.
3. Add optional reviewer profiles and reasoning overrides, sequential review rounds, strict combination into the existing verdict contract, unique output/telemetry labels, and whole-round retries under the existing budget. Preserve single-engine and auxiliary-session behavior.
4. Update root configuration, example, README, and memory with the explicit two-model preference. Validate the real JSON through the production parser, verify emitted argv, run reviewer tests and build, then the repository suite.
5. Inspect running reviewers before applying a restart. Do not interrupt active reviews or start duplicate supervisors; if a controlled idle restart is not available, report that the saved setting takes effect on restart. Keep unrelated working changes intact and commit only this task's documents/code locally; no push or PR.

Design: [Dual review models](../specs/2026-09-14-dual-review-models.md).

Verified 2026-09-14: the initial targeted run failed on missing profile support, missing reasoning argv, and missing two-model behavior. The completed repository suite passed 1,403 tests across 147 files; production build passed. The production config parser emitted `--model claude-fable-5-1` and `-m gpt-6-astra -c model_reasoning_effort="medium"` for the configured profiles. After checking a recent zero-in-flight heartbeat and no reviewer child processes, restarted only the idle reviewer. PID 7340's startup log confirms both configured models and medium effort; stderr was empty. Runtime config is saved locally (gitignored); the tracked example contains the same reviewer profiles. Existing settled reviews were not rerun.
