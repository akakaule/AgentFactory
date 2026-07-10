# The Factory Tour — Merged Deck Outline

**Combines:** Poul's *Fabrikstur* (business narrative + operated-service offer) · Alvin's *AgentFactory* deck (architecture + governance proof)
**Language:** English · **Product name:** AgentFactory · **Protocol:** ALP · **Brand:** context& × Agentics (co-branded)
**Offer framing:** Layered — operated service is the default path, co-build enterprise-hardening is the track for this customer.

---

## v3 — co-build-primary rework (current recommended deck)

The live deck is now **`agentfactory-cobuild-v3.html`** — 15 slides (10 main + 5 appendix). This is the version to present. It inverts the story per Alvin's direction: the meeting is about **co-building an enterprise-ready AgentFactory**, with the operated line as an *optional* model — not the dominant pitch. Purple leads (Alvin's co-build agenda); amber is the secondary/operated accent.

**The meeting's one-line frame:** *"How do we turn AgentFactory from a strong local-first, human-supervised agent workflow into an enterprise-ready platform for your environment — and optionally run capacity for you while we do it?"*

**v3 main flow (10):** 1 Why we're here (working session) · 2 The problem (letting an agent touch real backlog/repos/delivery safely) · 3 Live demo · 4 What makes it different (stations, gates, isolated worktrees, reviewable diff, human checkpoint) · 5 Control model (agents can't approve their own work) · 6 Current maturity (honest: strong control, not yet enterprise) · 7 Enterprise hardening backlog (the table) · 8 ALP vs AgentFactory (portability, no lock-in, own your definitions) · 9 Two ways to collaborate (**Track A co-build pilot primary / Track B operated line optional**) · 10 Next step (the ask).

**v3 appendix (5):** 11 Architecture · 12 Operated line in detail (Poul) · 13 Autonomy levels L1–L5 · 14 Business-model thesis (hours→factories) · 15 Operated-line pricing + ROI.

**Key changes made:** moved the "hours to factories" thesis and all pricing/ROI to appendix; demoted the "you're not buying a developer, you're buying a line" framing out of the main flow; added the honest **Current maturity** and **Enterprise hardening backlog** slides; rewrote **Two ways to collaborate** with co-build as Track A; changed the close to a concrete ask (backlog source · 3 candidate tasks · technical/security contact · business sponsor · six-month pilot shape).

**Softened phrases (applied):**

| Was | Now |
|-----|-----|
| "We haven't shown you anything today we can't deliver tomorrow." | "Everything shown today runs now; the enterprise hardening is exactly what we propose to scope together." |
| "The line works while you sleep." | "Agent work can continue asynchronously; approvals stay in your working hours and under your control." |
| "~9 of 10 tasks go through clean." | "We track clean pass rate, rework rate and human-override rate from the board." |
| "Running in 14 days." | "A first controlled line can run quickly; enterprise hardening is the six-month collaboration." |
| "emulated copies of your systems" | "isolated git worktree per task; reviewable diff against the merge-base" (precise) |

### Run-of-show — speaker split

| Part | Owner | Purpose |
|------|-------|---------|
| Opening / why we're here (1–2) | Alvin | Collaboration framing |
| Live demo (3) | Alvin | Prove AgentFactory is real |
| What's different / control / maturity / hardening (4–7) | Alvin | Show maturity and honesty |
| ALP & ownership (8) | Alvin (Poul supports) | Portability, no lock-in |
| Two ways to collaborate (9) | Both — Poul leads Track B | Co-build primary, operated optional |
| Next step (10) | Both | Align on collaboration |

**Pre-meeting alignment with Poul:** agree that the main storyline is collaboration around an enterprise-ready AgentFactory, and that the operated factory-line is positioned as an *optional operating model*, not the reason for the meeting. That keeps Poul's material valuable (appendix 12 + Track B) without it taking over. Only show appendix 12/14/15 (operated line, business model, pricing) if the customer asks.

---

## v2 — what changed (after Poul's 44-slide "Agentics-Fabrikstur 2")

The live deck is now **`factory-tour-merged-v2.html`** — 16 slides (13 main + 3 appendix), co-branded context& × Agentics (amber + purple on black), AgentFactory kept as the product name. Folded in from Poul's expanded deck:

- **New slide 2 — business-model thesis** ("The tasks are getting smaller — and that changes everything"): AI shrinks each task, so the 50-year hours × people model breaks → fixed price + subscription/capacity. This is Poul's strongest addition and now sits right after the title.
- **Deepened trust/security (slide 7):** added "separated from your data" (task source is only a job queue, no AI on it), "emulated environments," and "exit without hostages."
- **Capacity + 24/7 (slide 10):** added the capacity dial and "the line works while you sleep — approvals in your daytime."
- **Concrete pilot (slide 12):** Track B is now the explicit six-month, fixed-price pilot (greenfield or backlog; after six months: continue / take over / stop).
- **New pricing appendix (slides 15–16):** list price from 40,000 kr/mo per line, the "estimate → halve → compose lines + add-ons" method, and two worked ROI examples. Kept out of the main flow per the co-build/technical audience.

**v2 slide order:** 1 Title · 2 Why now (business model) · 3 The gap · 4 Live demo · 5 Stations · 6 The invariant · 7 Trust & security · 8 ALP vs AgentFactory · 9 Autonomy L3–L5 · 10 Buy a line (+capacity) · 11 Now not vision · 12 Two tracks (+pilot) · 13 Get started · 14 *Appendix* architecture · 15 *Appendix* pricing · 16 *Appendix* ROI.

**Still to confirm with Poul:** align his body text ("AgentFabric" → "AgentFactory"); confirm the co-branded lockup (context& × Agentics) is how you want to appear; source the "9 of 10" and pricing figures before showing them; have the ALP spec ready for the security-team review.

The slide-by-slide detail below describes the earlier 13-slide cut and still holds for the main-flow slides; the five items above are the deltas layered on top.

---

### (v1 slide-by-slide detail follows)

## Design principle for the merge

Poul's factory metaphor is the **spine** (the *why-buy*). Alvin's architecture and lifecycle slides are the **proof layer** (the *why-trust*) — inserted at the two moments a technical IT room will get skeptical: right after the demo ("can we trust the output?") and right before the offer ("does this meet our IT bar?"). One controlling metaphor, two voices, no seam.

**Speaker key:** 🅿 Poul (narrative, commercial) · 🅰 Alvin (builder, architecture, live demo)

---

## Slide 1 — The Factory Tour
**🅿 opens**
**Headline:** AgentFactory — a factory that's running now
**Kicker:** THE TOUR · context&
**Body:** This isn't another AI presentation — it's a tour of a factory that's already running. You're not meeting a vendor; you're meeting the team that built it.
**Visual:** Title slide, & watermark, four pills as the agenda (the stops).
**Notes:** Set the tone in the accent line: everything today is provable, nothing is roadmap. Introduce Alvin as the builder.

## Slide 2 — AI should have solved this. Why didn't it?
**🅿**
**Headline:** AI should have solved this. Why didn't it?
**Kicker:** BEFORE THE TOUR
**Body:** The backlog grows — the team doesn't. Everything waits on a human with a calendar. AI should have changed that, but most pilots never reach production: the demo impresses, but nobody dares give a black-box agent access to real systems. No quality gates, no audit — and no one accountable when it's wrong.
**Closer:** The problem isn't the model. It's everything around it: process, access, quality and accountability.
**Notes:** Ask the room: "How long is your queue right now — and how many AI pilots actually reached production?" Wait for the answer. This is the tour's reason to exist.

## Slide 3 — Stop 01: The factory floor  *(LIVE DEMO)*
**🅰 — live**
**Headline:** This is the floor. Let's put a task on the line.
**Kicker:** STOP 01 — THE FLOOR
**Body:** (Slide is just a prop.) Live board with the real stations. Take a task down the line; watch a worker pick it up; show the review station where a *different* agent checks the work; show the delivery station following the deploy pipeline and closing the task in the source system.
**Notes:** Pre-empt "how do we measure it?" — the metrics ARE the board's columns. Never promise a separate reporting tool. This maps to the live end-to-end run in demo-proposal.md.

## Slide 4 — Stop 02: From two boxes to quality stations
**🅰**
**Headline:** From two boxes to quality stations
**Kicker:** STOP 02 — THE STATIONS
**Left card — "How AI is usually sold":** Task → Solved · one black box in the middle · quality = hope.
**Right card — "How a line actually runs":** Understand → Spec → Build → Review → Deliver · each station = a fixed instruction + a quality gate · review by a *different* agent than the one that built it · the final station follows the deploy pipeline and closes the task in your system.
**Closer:** Quality is built into the line — not promised afterward.
**Notes:** Draw the two boxes first ("this is how most people think it works — and rightly, no one dares put that in production"), then reveal the stations. Trust lives in the stations, not the model.

## Slide 5 — The invariant: a line where the agent can't approve its own work  *(PROOF)*
**🅰 — technical proof layer**
**Headline:** The one rule that makes it safe: agents can't approve or deliver
**Kicker:** UNDER THE FLOOR
**Body / pipeline strip:** backlog → queued → in_progress → in_review → delivering → done.
**Three points:** (1) Every state change is a declared edge keyed by *(from, to, by: human | agent)* — nothing undeclared can happen. (2) Approving, reopening, force-completing are **human-only** edges; agents can never delete or approve. (3) Delivery is **machine-verified** — a watcher confirms the PR is merged and CI is green, or the task goes back to the queue. No agent can fake "done."
**Notes:** This is the answer to the unspoken "can we trust AI output?" in a technical room. Keep LLM mechanics for the appendix.

## Slide 6 — ALP is the protocol. AgentFactory is the factory.
**🅰 / 🅿**
**Headline:** ALP is the protocol. AgentFactory is the factory.
**Kicker:** GIT VS. GITHUB
**Left card — ALP, the open standard:** stations, lines and gates as an open protocol · definitions in plain text · audit history in git — portable · your process can always move.
**Right card — AgentFactory, the factory in operation:** our running factory, built on ALP · runs real customer tasks today, ticket → approved delivery · built by the team in front of you · set up, monitored and operated by us.
**Closer:** Like git and GitHub: the standard is open — the value is the operated service.
**Notes:** The bridge to the offer: the standard is open, but someone has to run the factory — that's us. You own the definitions even though we operate it.

## Slide 7 — Where you sit on the autonomy curve  *(STRATEGIC FRAME)*
**🅿 / 🅰**
**Headline:** You move up the levels by tightening or loosening a gate — not by a rewrite
**Kicker:** THE TRANSITION · L1 → L5
**Five-level strip (L3–L5 highlighted):** L1 assisted · L2 copilot · **L3 bounded autonomy** (agent completes whole tasks in guardrails, human approves each) · **L4 orchestrated fleet** (many tasks in parallel, review by exception) · **L5 self-delivering** (queue → verified delivery, minimal human touch).
**Two points:** Autonomy is a property of the *deployment*, not the model — AgentFactory *is* the controls. Where the gates sit defines your level; that's a configuration decision, task by task.
**Notes:** Aligned to the Context& AI Transition model (learn.contextand.com/cs/ai-transition) and the 5-level agent-autonomy scale. A pilot starts at L3 (review everything) and earns its way to L4/L5.

## Slide 8 — Governance, audit & security for strict IT  *(ENTERPRISE PROOF)*
**🅰**
**Headline:** Built to sit inside your controls
**Kicker:** FOR STRICT IT
**Three cards:** (1) **Auditable** — metrics, analytics and review state are all *derived* from an append-only activity log; a complete, replayable chain of custody per task; AI-review findings are walled off from the implementing agent. (2) **Self-hosted & resident** — runs on your infrastructure; state in a local DB; git-host auth via env tokens, no secrets in the board; per-task git worktree isolation. (3) **CI/CD-native** — PR-based flow; delivery verified on GitHub or Azure DevOps; merged + green, or back to the queue.
**Callout:** It's single-user and local by design today — that's exactly what the co-build track (slide 11) extends, without loosening any of it.
**Notes:** For deep compliance questions, offer a separate technical review of the ALP spec with their security people rather than going deep here.

## Slide 9 — You're not buying a developer. You're buying a line.
**🅿**
**Headline:** You're not buying a developer. You're buying a line.
**Kicker:** THE OFFER
**Body:** A line takes one task at a time through the stations — tested, reviewed, delivered back into your system. In the price: the people behind it — a **line-manager** who watches the board, catches stuck tasks, puts questions back to you, and pushes work through. Behind the line-manager stands a team — delivery never depends on one person.
**Closer:** It doesn't all run by itself — that's why we're there.
**Capacity, folded in:** Capacity is one dial. Five in the queue? Take one line and let them wait, or take two and double throughput. A queue means line #1 already proved its worth.
**Notes:** Sell capacity and quality *on top of* their own team — never "you won't need developers." The role is consistently "line-manager." Honesty with a number: ~9 of 10 tasks go through clean; the tenth just goes back on the belt — that's what the line-manager is for. (Be ready to source the number.)

## Slide 10 — What you're buying today (now, not vision)
**🅿**
**Headline:** What you're buying is what you buy today
**Kicker:** NOW — NOT VISION
**Left card — what we don't sell:** future visions on the invoice · full autonomy without humans · a replacement for your own people.
**Right card — what runs now:** a line in AgentFactory with stations and gates · a live board with your tasks · a line-manager and a team behind it · capacity and quality, on top of your team.
**Closer:** We haven't shown you anything today we can't deliver tomorrow.
**Notes:** If anyone digs into roadmap: "We sell what runs. That's why we could demo it instead of drawing it." Never say "no developers" to a customer.

## Slide 11 — Two ways to start  *(THE MERGE CENTERPIECE — layered offer)*
**🅿 + 🅰 jointly**
**Headline:** Two ways to start — pick your track
**Kicker:** THE OFFER · LAYERED
**Left card — Track A · Operated (default, fast):** Running in 14 days. We set up, monitor and operate the factory for you; you buy lines and capacity. Best when you want throughput now.
**Right card — Track B · Co-build enterprise (this customer):** A bounded ~6-month partnership to harden AgentFactory for your IT — SSO/RBAC, hardened deployment, compliance mapping, deeper Azure DevOps / GitHub Enterprise hooks — on your infrastructure, on top of the same guarantees. You own more; we build it with you.
**Closer:** Open protocol, operated by us — or built together with you.
**Notes:** This is the seam-healer. Both tracks share the same factory and the same governance; they differ only in who operates and how much you own. For a build-ambitious customer, lead toward Track B but keep Track A as the way to see value immediately.

## Slide 12 — Get started
**🅿 closes**
**Headline:** From tour to a running line
**Kicker:** GET STARTED
**Three steps:** **Day 1** — we connect to your task source (Jira, Azure DevOps or email); one day's work, no migration. **Days 2–14** — we define the stations together, in plain text, in the open protocol; you own the definitions. **First task** — onboarding ends when your first real task has run the line and been delivered back into your system.
**The ask (in the room):** For the operated track — book a Day-1 date, name one task source and three candidate tasks. For the co-build track — agree the collaboration question ("how would you want to build this with us?") and scope a bounded pilot.
**Closer:** Limited slots after the summer — have the backlog ready.
**Notes:** Turn "the bottleneck becomes you" into a positive: a queue means the line proved its worth. Never promise self-service.

## Slide 13 — Appendix: architecture & data residency  *(technical Q&A backup)*
**🅰 — only if asked**
**Headline:** How it's built
**Kicker:** APPENDIX
**Content:** Six packages, npm workspaces, strict TypeScript. One package owns the DB and all lifecycle rules; three headless supervisors — a **dispatcher** (spawns one fresh agent session per queued task), a **reviewer** (advisory second-agent verdict), and a **watcher** (verifies delivery on the git host over REST, no LLM). Web layer is an API + live board. Task state is a local database; each task runs in its own git worktree; nothing about the work has to leave your network.
**Notes:** This is the slide you jump to for deep IT/architecture questions. Offer the ALP spec review for security teams.

---

## Merge notes / open items to confirm with Poul
- **Naming:** deck standardises on **AgentFactory** (product) / **ALP** (protocol) / **context&** (company). Poul's draft used "AgentFabric" — align all customer-facing material.
- **Station labels:** the demo board should use the same words as slide 4 (Understand → Spec → Build → Review → Deliver). The repo's internal states (queued/in_progress/in_review/delivering/done) appear only on the proof slide 5.
- **The "9 of 10" figure:** keep it only if you can source it from real operating data.
- **ALP openness:** slides 6 and 13 lean on ALP being an open, publishable protocol. Have the spec ready for the security-team review Poul offers.
- **Speaker split:** Poul owns 1, 2, 9, 10, 12; Alvin owns 3, 4, 5, 8, 13; shared on 6, 7, 11.
