# AgentFactory — Demo & Engagement Proposal

**Audience:** Customer CIO + hands-on IT / engineering (technical deep-dive)
**Goal of the meeting:** Land a co-development partnership to enterprise-harden AgentFactory
**Demo style:** Live, end-to-end run
**Prepared for:** Alvin Kaule · July 2026

---

## 1. What this meeting needs to achieve

The CIO reached out off the back of the LinkedIn post because AgentFactory answers a question their IT department is already asking: *how do we let AI agents do real engineering work without giving up control?* This audience is technical and skeptical — they will judge on architecture, not on slogans.

So the demo has one job: **prove that autonomy and governance are not a trade-off here.** Every impressive thing an agent does on screen should be immediately followed by the control that contains it. Show the power, then show the gate.

Lead with the three things this audience told us matter most — **CI/CD integration, auditability/governance, and security/data residency** — and let the autonomy-levels story be the strategic frame that ties them together.

---

## 2. The narrative arc (what to focus on)

Structure the whole session around a single idea: **the board owns the truth; the agents just do the work.** That one architectural decision is what makes everything else — audit, guardrails, delivery verification — possible. Keep returning to it.

Focus your time on these five parts of AgentFactory, in this order of emphasis:

1. **The task lifecycle and its guardrails** — the state machine where agents *cannot* approve or delete. This is your strongest governance proof and it is enforced by construction, not by policy. Spend the most time here.
2. **The three supervisors (dispatcher / reviewer / watcher)** — because "the board never runs an agent itself" is the design decision that separates control plane from execution. The watcher especially: delivery is *machine-verified* (PR merged + pipeline green), not agent-asserted.
3. **The activity log as source of truth** — metrics, analytics, and review state are all *derived* from an append-only log, so audit works retroactively. This is the answer to "prove to me what happened."
4. **Isolation & data residency** — per-task git worktrees, fresh agent session per task, local SQLite state, secrets via env only. This is the answer to "does our data leave the network." (It doesn't.)
5. **CI/CD fit** — the PR-based flow and GitHub / Azure DevOps verification, so it slots into their existing pipeline instead of replacing it.

Deliberately *underplay* the single-user / local-only limitation — but do not hide it. Frame it as the natural starting point and the reason the co-development conversation exists (see §6).

---

## 3. The live end-to-end demo

You chose a live run — it's the highest-impact option and this audience will respect it. The risk is that a live agent does something unpredictable in front of the CIO. Mitigate by scripting the *task*, not the outcome, and by having a fallback (see §5).

### Suggested flow (~15 minutes)

| # | On screen | What you say | Underlying point |
|---|-----------|--------------|------------------|
| 1 | The board UI, a clean backlog | "This is the single source of truth. Nothing runs until a human queues it." | Human owns the entry gate |
| 2 | Queue one prepared task | "I move it to *queued*. Watch — I'm not starting an agent; the dispatcher will." | Board ≠ agent; control plane is separate |
| 3 | Dispatcher claims it → *in_progress* | "A fresh, isolated `claude -p` session just started in its own git worktree." | Isolation, no shared context |
| 4 | Progress updates stream in | "It's reporting progress back over MCP. Every step is logged and attributed." | Auditability, live |
| 5 | Agent pushes a branch, submits → *in_review* | "It pushed `feature/<key>-…` to origin *before* submitting. It cannot merge. It cannot approve." | Agents can't approve/deliver |
| 6 | AI reviewer's advisory verdict appears | "A second agent posted an `ai-review/v1` verdict — advisory only, and stripped from what the implementing agent ever sees." | AI review is walled off |
| 7 | Human approves → *delivering* | "*I* approve. That's a human-only edge in the state machine." | Human gate, enforced by construction |
| 8 | Watcher moves it → *done* | "No LLM did this. The watcher checked the real PR: merged and pipeline green. That — and only that — is 'done'." | Machine-verified delivery |
| 9 | Open the task's full history | "Here's the entire chain of custody for this one task: who queued it, which agent, which branch, what I approved, which PR delivered it." | Retroactive, replayable audit |

### The one-liner to close the demo
> "You just watched an agent take a task from queue to merged, verified delivery — and at no point could it approve or ship its own work. That's the whole product."

---

## 4. Working the autonomy levels (L3 → L4 → L5)

This is your strategic frame and it aligns directly with the **Context& AI Transition model** (learn.contextand.com/cs/ai-transition) and the widely-used five-level agent-autonomy scale. The move that lands with a CIO: **autonomy is a property of the *deployment*, not the model.** The same agent is safe or reckless depending on the controls around it — and AgentFactory *is* those controls.

Map it explicitly so they can locate themselves on the journey:

- **Levels 1–2 (assisted / copilot):** where most enterprises are today — autocomplete and chat-driven help, human steering every step. Valuable, but doesn't scale headcount.
- **Level 3 — bounded autonomy:** an agent completes a *whole task* inside guardrails and a human approves each result. **This is where a pilot starts.** Review everything; build trust; the state machine guarantees the agent can't overstep.
- **Level 4 — orchestrated fleet:** many tasks decomposed, queued and run in parallel; humans review *by exception* rather than reviewing everything. AgentFactory's dispatcher + queue is exactly this substrate.
- **Level 5 — self-delivering:** queue → build → review → merge → verified delivery with minimal human touch, because the watcher provides the objective delivery gate. You never remove control — you move it from *per-task human approval* to *automated policy + exception review*.

The key message: **moving up the levels is a configuration decision, task-by-task — tighten a gate to sit at L3, loosen it toward L5 — not a rewrite and not a leap of faith.** The board makes the transition governable. That is precisely what a strict IT department needs to hear before it will allow any autonomy at all.

Tie it back to their business case: the ROI of L4/L5 is real (parallel throughput, review-by-exception), but it is only unlockable *if* governance keeps pace. AgentFactory is how governance keeps pace.

---

## 5. De-risking the live run

- **Rehearse the exact task** end-to-end on the same machine, same repo, the morning of — twice.
- **Pick a small, deterministic task** (e.g. a well-tested utility change) so the agent's output is predictable and the CI run is fast.
- **Have a pre-baked board** with tasks already sitting at each stage, so if the live agent stalls you can narrate a completed run without losing the story.
- **Record a screen capture** of a clean successful run beforehand as the ultimate fallback.
- **Pre-warm everything:** dispatcher, reviewer, watcher, and the web server all running and pointed at the same DB; branches and tokens (`GITHUB_TOKEN` / `AZDO_PAT`) configured.
- **Rebuild `dist` and restart the long-lived processes** before the demo — MCP sessions and the :8787 server cache the build they started with.
- **Network:** confirm outbound access to the git host from the demo environment, or use a local mirror.

---

## 6. Turning the demo into the partnership

The honest framing is your strongest asset: AgentFactory is deliberately **single-user and local-first today** — that's *why* the governance guarantees are so clean, and it's the natural jumping-off point for co-development. Do not oversell a multi-tenant enterprise product you don't have; sell the **control model** that already works and the joint roadmap to scale it.

Position the co-development work as extending the existing guarantees, never loosening them:

- **Identity:** multi-user, RBAC, SSO/SAML layered onto the human-gate model — approvals become named, role-scoped actions in the audit log.
- **Deployment:** hardened, containerised, air-gap-friendly install; a Postgres option for scale; backup/DR runbooks.
- **Compliance:** exportable audit reports, retention policy, and a mapping of the activity log to *their* control framework.
- **Integration:** deeper GitHub Enterprise / Azure DevOps hooks, their CI gates, and connectors to their ticketing system.

### The ask
A joint **Phase 1 pilot on their infrastructure** — one repo, their CI, their security review. Then invite the room to hand you their single strictest IT requirement and offer to design the control for it together and prove it in the pilot. That converts a demo into a collaboration.

### Suggested phasing
1. **Pilot** — deploy on their infra, one repo, live end-to-end run, validate security & audit posture.
2. **Harden** — SSO, RBAC, deployment and compliance workstreams built jointly against their requirements.
3. **Scale** — roll out across teams; move from L3 review-everything to L4/L5 review-by-exception.

---

## 7. Questions to expect (and where to point)

- *"Can the agent merge its own code?"* → No — human-only approval edge, and the watcher owns delivery. Show the transition table.
- *"What leaves our network?"* → Task state and code stay local; only the LLM API calls the agent itself makes go out — which run under your existing agent tooling and policy.
- *"How do we know it actually delivered?"* → The watcher checks the real PR over REST: merged + checks green, or it bounces back to the queue. No agent can fake "done."
- *"How do we audit a decision months later?"* → Everything is derived from the append-only activity log; pull the full per-task chain of custody.
- *"It's single-user — that's a blocker."* → Correct, today. That's Phase 2, and it's exactly what the partnership builds — on top of, not instead of, these guarantees.
