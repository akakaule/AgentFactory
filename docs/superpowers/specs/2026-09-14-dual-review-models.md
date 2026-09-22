# Dual review models

Each new board task review must run Claude Fable and GPT-6 Astra with medium reasoning. Add an optional ordered `reviewers` list to the existing supervisor configuration, preserving the single-engine configuration for compatibility and auxiliary visualization/feedback evaluation. Pin Fable to `claude-fable-5-1`, the documented current Fable model, and Astra to `gpt-6-astra`.

Run the configured reviewers sequentially within one task review attempt, with independent prompts built from the same task/diff snapshot. Post a single combined `ai-review/v1` only when both outputs validate. Preserve and label all findings by configured engine/model; clean requires both clean. This prevents the existing clean document-review auto-advance hook from firing after only one reviewer. No core schema or lifecycle changes are needed.

If either reviewer fails, burn the existing attempt budget and retry the whole round. Restarting the supervisor also repeats an unfinished round. Ignore results for a superseded submission or a task that left review. Give each model distinct log/output files and OTel worker labels. Keep the current concurrency cap and single visualization pass.

Source references: [Fable model ID](https://platform.claude.com/docs/en/models/fable-5-1/overview), [Astra reasoning support](https://developers.openai.com/api/docs/models/gpt-6-astra), [Codex reasoning configuration](https://learn.chatgpt.com/docs/config-file/config-reference).
