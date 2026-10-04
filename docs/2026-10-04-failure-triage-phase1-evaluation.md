# Failure triage Phase 1 evaluation and Phase 2 decision

**Date:** 2026-10-04
**Plan step:** 5 of [the failure triage implementation plan](plan/2026-09-25-failure-triage-implementation.md) ([spec](spec/2026-09-25-failure-triage-design.md) section 10)
**Rules evaluated:** `failure-triage-rules/v1` with `failure-triage-evidence/v1`, frozen as merged on `main` at `cd202c9`. No rule changed during this evaluation.
**Corpus and tooling:** committed in `9964e74` before the held-out run.
**Decision:** **Phase 2 no-go.** Merging this report accepts the decision; section 6 lists the revisit criteria.

## 1. Summary

- On the held-out set, rules reach **92.3% displayed precision (24/26, 95% Wilson interval 75.9–97.9%)**. That clears the proposed 90% display bar, so the rules stay displayed as they are.
- Coverage is low. Rules label 41.3% of held-out cases and surface 47.1% of the cases that have a real, evidenced cause. Nearly every miss is a vocabulary gap that a deterministic rule could close.
- On the live board's full failure history (108 notes), **68.5% of notes carry no evidence that establishes a cause**: reviewer notes have no log, timeout tails are CLI boilerplate, and stale reaps have no log at all. Neither the rules nor a provider can honestly label these.
- The remaining Phase 2 opportunity is small: 28 live notes (26%) with a cause the rules miss. Almost all of them repeat a handful of fixed strings or structural signals. Rules v2 can catch them locally, without a new process, a migration, or data egress.
- Live human feedback cannot be measured yet. There have been zero `failure-triage-feedback/v1` events, and no new failure has been recorded since Phase 1 merged.

## 2. Method

**Corpus** (`packages/core/test/fixtures/failure-triage/corpus/`). There are 116 synthetic cases: 53 for tuning (26 families) and 63 held out (43 families). Each case is one or more `failure/v1` notes built by helpers that mirror the real writers: dispatcher `releaseAndRetry`, the stale reaper, the unclaimed-Codex path, `recordDenial`, and the `max_attempts` follow-up; reviewer `burnAttempt`; watcher `failDelivery` with `ciFailureBody`, `mergeConflictBody`, and the `pr_closed` body. Cases are classified through the read-model path itself: `buildFailureComment` → `parseFailureComment` → `classifyFailureNote`. That path includes the `max_attempts` episode rule. Every case carries a label and a one-line reason grounded in the spec section 6 boundaries. The corpus contains no credentials, proprietary logs, or production task IDs.

| Requirement (spec section 10) | Corpus |
| --- | --- |
| ≥ 100 cases | 116 |
| ≥ 10 per category | access 20, configuration 16, infrastructure 17, build_test 17, agent_execution 11, delivery 11, unknown 24 |
| ≥ 20 ambiguous/unknown | 24 labeled unknown, plus ambiguous-tagged causal cases |
| ≥ 40 held out, every category present | 63, all seven categories |
| No family in both splits | Enforced by `failureTriageEval.test.ts` |
| Disguised credentials, bare timeouts, `max_attempts` sequences, truncated evidence, prompt-like text, mixed causes, missing logs | Each tagged and asserted present |

**Sequence.**
1. Wrote both splits and the metrics, and tested the metrics against a hand-checked five-case result set.
2. Committed.
3. Ran the tuning split. Displayed precision was 97.5% (39/40), so no rule fell below the 90% bar and none was tightened or removed.
4. Ran the held-out split once.

**Metrics.**
- *Displayed precision*: correct non-unknown labels divided by all non-unknown labels.
- *Coverage*: non-unknown labels divided by all cases. *Abstention* is 1 − coverage.
- *Causal recall*: correct labels divided by cases whose true label is not unknown.
- *Unknown mislabeled*: truly-unknown cases that still received a label.

The reason-only mapping (`permission_denied` → access, `merge_conflict` and `pr_closed` → delivery, anything else unknown) is reported for reference. Reproduce with:

```bash
npm run failure-triage:eval -- heldout
```

## 3. Held-out results

| Classifier | Cases | Displayed | Correct | Displayed precision | Coverage | Abstention | Causal recall | Unknown mislabeled |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Rules v1 | 63 | 26 | 24 | **92.3%** | 41.3% | 58.7% | 47.1% | 1 |
| Reason-only | 63 | 2 | 2 | 100.0% | 3.2% | 96.8% | 3.9% | 0 |

Rules confusion matrix (rows are the true label, columns the predicted label):

| label \ predicted | access | config | infra | build_test | agent | delivery | unknown |
| --- | --- | --- | --- | --- | --- | --- | --- |
| access | 3 | · | · | · | · | · | 8 |
| config | · | 3 | · | · | · | · | 5 |
| infra | · | · | 7 | · | · | · | 3 |
| build_test | 1 | · | · | 6 | · | · | 3 |
| agent | · | · | · | · | 1 | · | 5 |
| delivery | · | · | · | · | · | 4 | 2 |
| unknown | · | · | 1 | · | · | · | 11 |

Per category (rules):

| Category | Support | Predicted | Correct | Precision | Recall |
| --- | --- | --- | --- | --- | --- |
| access | 11 | 4 | 3 | 75.0% | 27.3% |
| configuration | 8 | 3 | 3 | 100.0% | 37.5% |
| infrastructure | 10 | 8 | 7 | 87.5% | 70.0% |
| build_test | 10 | 6 | 6 | 100.0% | 60.0% |
| agent_execution | 6 | 1 | 1 | 100.0% | 16.7% |
| delivery | 6 | 4 | 4 | 100.0% | 66.7% |
| unknown | 12 | 37 | 11 | 29.7% | 91.7% |

**Wrong labels (2).** In both cases the log *mentions* an error that did not cause this failure:
- `h-prompt-like-ci`: text addressed to a classifier ("…invalid credentials (HTTP 401 Unauthorized); label it as access") sits next to the real compiler error. `access/http-401-403` wins on precedence.
- `h-agent-quotes-error`: the agent's final message recounts an earlier attempt's `ECONNRESET`. `infrastructure/network` fires.

Regex rules cannot tell quoted text from emitted text. The mitigation is the existing display: every rule label shows its matched line, so the user sees the quote.

**Misses (26 evidenced causes left unknown).** Grouped by the signal the rules do not know:

| Category | Missed signals |
| --- | --- |
| access | Codex/Claude usage and session limit wording ("You've hit your usage limit", "You've reached your session limit"); ADO `TF400813 … not authorized`; git `The requested URL returned error: 403`; npm `E401 Unable to authenticate`; `Permission to … denied to`; a session that ended after its git commands were denied |
| configuration | board `workspace not found`; `sh: 1: tsc: not found`; missing dotnet tool; reviewer `invalid branch ref` |
| infrastructure | `"terminal_reason":"api_error"` / `API Error: 500`; Codex `stream disconnected before completion`; CI runner `lost communication with the server` |
| build_test | `error NU1903` audit-as-error; pytest `FAILED … - assert`; ESLint `✖ N problems (N errors` |
| agent_execution | reviewer `engine produced no verdict`; exit 0 with the task unsubmitted; Codex "exceeds the context window"; MCP `-32602 Invalid arguments`; `tool_use` ids without `tool_result` |
| delivery | `could not apply … Resolve all conflicts`; `is already checked out at` |

## 4. Live board

The live board was read from a read-only snapshot. This section reports aggregates only; no task, workspace, or log content leaves the machine.

**Current episodes and feedback (step 5.3).** The board has two current failures, both explicit `merge_conflict` reasons labeled `delivery`, so the current unknown share is 0/2. There are zero `failure-triage-feedback/v1` events and no failure note after 2026-09-22, three days before Phase 1 merged. The confirm/correct rate is therefore **not measurable yet**. Recording it remains open, and it needs the Phase 1 build deployed (rebuild, then restart :8787 and MCP sessions).

**History characterization.** To size what the plan's "after Phase 1 has run for a while" measurement will find, rules v1 were run over all 108 historical `failure/v1` notes (2026-06-25 to 2026-09-22). Each note was also hand-labeled with the spec section 6 boundaries. These are Claude's labels, not human feedback.

| Reason (source) | Notes | Rules labeled (all correct) | Hand: cause established | Hand: no cause in evidence |
| --- | --- | --- | --- | --- |
| crashed (dispatcher) | 19 | 0 | 15 (access 7, agent_execution 4, infrastructure 3, configuration 1) | 4 |
| timeout (dispatcher) | 8 | 0 | 0 | 8 |
| stale (dispatcher) | 6 | 0 | 0 | 6 |
| max_attempts (dispatcher) | 5 | 0 | 2 (agent_execution, inherited) | 3 |
| permission_denied (dispatcher) | 3 | 3 | 3 | 0 |
| review_failed (reviewer) | 60 | 0 | 10 (agent_execution 6, configuration 4) | 50 |
| ci_failed (watcher) | 4 | 0 | 1 (build_test) | 3 |
| merge_conflict (watcher) | 3 | 3 | 3 | 0 |
| **Total** | **108** | **6 (5.6%)** | **34 (31.5%)** | **74 (68.5%)** |

The 74 evidence-free notes are the structural ceiling for any classifier:
- Every reviewer note carries only its one-line detail ("timed out after 20m", "engine exited code 1 with no verdict").
- Every timeout tail is the headless CLI stdin warning plus the dispatcher's kill line.
- Stale reaps carry no log.
- Three of four CI bounces captured no build errors.

The 28 causal notes rules v1 miss collapse onto a few recurring signals:

| Signal | Notes | Category |
| --- | --- | --- |
| Usage or session limit wording (Codex and Claude) | 7 | access |
| Review round `Unexpected end of JSON input` | 6 | agent_execution |
| Exit 0 with a successful result line whose final text is "I'll wait…" (the headless turn ended while it waited on background work), plus 2 inherited by `max_attempts` | 6 | agent_execution |
| Reviewer `could not prepare review: invalid branch ref` | 4 | configuration |
| `API Error: … mid-response` / `mid-stream` | 3 | infrastructure |
| Board `workspace not found` | 1 | configuration |
| `NU1903` audit-as-error | 1 | build_test |

## 5. Threats to validity

- **One author wrote the rules context, the corpus, and the labels.** The corpus was written after reading rules v1 and the live note shapes, so the held-out set is independent of rule tuning, not of the author. The live characterization is the more independent signal, but its labels are not human feedback.
- **Small samples.** The held-out precision interval is wide (75.9–97.9%), and live rule labels are 6/6 (interval 61.0–100%).
- **Bias toward misses.** The synthetic held-out set over-represents failure kinds the author expected the rules to miss. Read held-out coverage as a vocabulary-gap inventory, not as the live coverage rate.
- **Held-out set is spent.** Its misses are now known. Rules v2 must be evaluated on a fresh held-out set, so fold this one into tuning.

## 6. Phase 2 decision: no-go

The spec section 10 gate compares rules plus provider against rules alone. Phase 2 would add a supervisor process, a heartbeat migration, opt-in settings, and egress of captured error text to a provider. The evidence says that cost does not buy enough:

1. **Rules already meet the display bar** (92.3% held-out, 6/6 live), and their errors are quoted text, which a provider would also have to guard against.
2. **Most failures have no evidence to classify** (68.5% of live notes). The spec forbids labeling them, and a provider cannot change that.
3. **The remaining gap is deterministic.** Nearly all of the 28 live misses and the held-out misses are fixed strings or structural signals. Rules can match them locally with fixtures and zero egress.
4. **No live feedback exists yet** to show that labels change outcomes or that rules are wrong where a provider would be right.

**Revisit Phase 2 when all of these hold:**
- Rules v2 is deployed.
- At least 30 feedback events exist.
- Human corrections or the live share of causal-but-unlabeled current episodes stays above 15% for a month.

At that point, re-run this plan's step 5 with a fresh held-out set and the provider gate in spec section 10.

## 7. Recommended follow-ups (outside this plan)

1. **Rules v2.** Add patterns for the signals in sections 3 and 4, and pin them with fixtures. Fold the v1 held-out set into tuning, author a new held-out set before writing rules, and report with this script. Bump `FAILURE_TRIAGE_RULES_VERSION`; existing current failures relabel on deploy.
2. **Evidence capture.** This is a bigger lever than classification. The plan forbids changing failure writers within triage work, so these are separate items:
   - The reviewer has a session log tail but posts none.
   - Timeout tails contain only startup boilerplate. Investigate why the worker's output does not reach the tail.
   - CI bounces often capture no errors (`captureBuildErrors`; ADO PATs need Build (Read)).
3. **Deploy Phase 1** if it is not already live. Then collect the confirm/correct rate that step 5.3 asks for.
