const pptxgen = require("pptxgenjs");
const p = new pptxgen();
p.defineLayout({ name: "W16x9", width: 13.333, height: 7.5 });
p.layout = "W16x9";
p.author = "context& × Agentics";
p.title = "AgentFactory — Enterprise Co-Build Working Session";

const BG="0B0A10", INK="F5F3F8", MUT="A7A1B4", PUR="8B5CF6", PURB="A78BFA",
      AMB="F6851F", AMBB="FFA640", LINE="2B2733", CARD="141119", GREEN="4ADE80", CARD2="17141F";
const SANS="Arial", MONO="Courier New";
const ML=0.92, MR=12.41, W=11.49, FY=6.98;
const shadow = () => ({ type:"outer", color:"000000", blur:9, offset:3, angle:90, opacity:0.35 });

function base(slide, opts={}){
  slide.background = { color: BG };
  slide.addText("&", { x:9.2, y:-1.3, w:5, h:8, fontFace:"Georgia", fontSize:430, bold:true,
    color:CARD2, align:"right", valign:"middle" });
  slide.addText([
    { text:"context", options:{color:INK,bold:true} },
    { text:"&", options:{color:PURB,bold:true} },
    { text:"  ×  ", options:{color:MUT} },
    { text:"> agentics", options:{color:AMBB,bold:true} },
  ], { x:ML, y:FY, w:5, h:0.3, fontFace:SANS, fontSize:10, align:"left", valign:"middle", margin:0 });
  if(opts.foot) slide.addText(opts.foot, { x:MR-5, y:FY, w:5, h:0.3, fontFace:SANS, fontSize:9.5,
    color:MUT, align:"right", valign:"middle", margin:0 });
  if(opts.speaker) slide.addText(opts.speaker, { x:MR-3.2, y:0.42, w:3.2, h:0.32, fontFace:SANS,
    fontSize:10, color:MUT, align:"right", valign:"middle", margin:0 });
  if(opts.appx) slide.addText("APPENDIX", { x:ML, y:0.42, w:3, h:0.3, fontFace:MONO, fontSize:9.5,
    color:AMBB, align:"left", valign:"middle", margin:0 });
}
function kicker(slide, t, y=0.92){
  slide.addText("// "+t.toUpperCase(), { x:ML, y, w:W, h:0.32, fontFace:MONO, fontSize:11.5,
    bold:true, color:PURB, align:"left", valign:"middle", margin:0 });
}
function title(slide, runs, y=1.35, size=33, w=W){
  slide.addText(runs, { x:ML, y, w, h:1.25, fontFace:SANS, fontSize:size, bold:true,
    color:INK, align:"left", valign:"top", margin:0, lineSpacingMultiple:1.02 });
}
function closer(slide, t, color=PURB, y=5.95, size=18, w=W){
  slide.addText(t, { x:ML, y, w, h:0.9, fontFace:SANS, fontSize:size, bold:true, color,
    align:"left", valign:"top", margin:0, lineSpacingMultiple:1.05 });
}
function bullets(items){
  return items.map((it)=>{
    const runs = Array.isArray(it)? it : [{text:it}];
    return runs.map((r,j)=>({ text:r.text, options:{
      bold:!!r.bold, color:r.color||"D6D1E0",
      bullet: j===0? { code:"203A", indent:16 } : false,
      breakLine: j===runs.length-1
    }}));
  }).flat();
}
function card(slide, o){
  slide.addShape(p.shapes.ROUNDED_RECTANGLE, { x:o.x, y:o.y, w:o.w, h:o.h, rectRadius:0.12,
    fill:{color:CARD}, line:{color:o.accent||LINE, width:o.accent?1.5:1}, shadow:shadow() });
  let ty=o.y+0.28;
  if(o.head){ slide.addText(o.head.toUpperCase(), { x:o.x+0.35, y:ty, w:o.w-0.7, h:0.3,
    fontFace:MONO, fontSize:11, bold:true, color:o.accent||MUT, margin:0 }); ty+=0.42; }
  if(o.best){ slide.addText(o.best, { x:o.x+0.35, y:ty, w:o.w-0.7, h:0.32, fontFace:SANS, fontSize:11.5,
    italic:true, color:MUT, margin:0 }); ty+=0.44; }
  if(o.items){ slide.addText(bullets(o.items), { x:o.x+0.35, y:ty, w:o.w-0.62, h:o.y+o.h-ty-0.2,
    fontFace:SANS, fontSize:o.fs||13, color:"D6D1E0", align:"left", valign:"top", margin:0,
    paraSpaceAfter:o.gap!=null?o.gap:7, lineSpacingMultiple:1.02 }); }
  if(o.body){ slide.addText(o.body, { x:o.x+0.35, y:ty, w:o.w-0.7, h:o.y+o.h-ty-0.2, fontFace:SANS,
    fontSize:o.fs||13, color:"D6D1E0", align:"left", valign:"top", margin:0, lineSpacingMultiple:1.06,
    paraSpaceAfter:8 }); }
}

// 1
let s = p.addSlide(); base(s, { foot:"A working prototype — and an honest look at the gaps", speaker:"Alvin" });
kicker(s, "A working session", 2.05);
s.addText("AgentFactory", { x:ML, y:2.35, w:W, h:1.1, fontFace:SANS, fontSize:54, bold:true, color:INK, margin:0 });
s.addText("You've seen AgentFactory and you're interested in collaboration. Today isn't only a product pitch — it's a working session on whether we should harden it for enterprise use in your environment, together.",
  { x:ML, y:3.55, w:7.6, h:1.4, fontFace:SANS, fontSize:17, color:"E3DFEA", margin:0, lineSpacingMultiple:1.12 });
const pills=["The problem","Live demo","What's different","Current maturity","How we'd collaborate"];
let px=ML; pills.forEach(t=>{ const w=0.32+t.length*0.098; s.addShape(p.shapes.ROUNDED_RECTANGLE,
  {x:px,y:5.2,w,h:0.44,rectRadius:0.22,fill:{color:CARD},line:{color:LINE,width:1}});
  s.addText(t,{x:px,y:5.2,w,h:0.44,fontFace:SANS,fontSize:11,color:MUT,align:"center",valign:"middle",margin:0}); px+=w+0.18; });

// 2
s = p.addSlide(); base(s, { foot:"The problem worth solving", speaker:"Alvin" });
kicker(s, "Why this matters");
title(s, [{text:"Getting an agent to write code is ",options:{color:INK}},{text:"the easy part",options:{color:AMBB}}], 1.35, 33);
s.addText("The backlog grows — the team doesn't. Agent pilots impress in a demo but rarely reach production. The hard part isn't generating code. It's letting an agent touch real backlog, real repositories and a real delivery flow — safely, with clear ownership and review gates.",
  { x:ML, y:2.75, w:11.0, h:1.7, fontFace:SANS, fontSize:17.5, color:MUT, margin:0, lineSpacingMultiple:1.2 });
closer(s, "No quality gates, no audit, no clear ownership — that's where pilots stall. That's the gap this is built to close.", PURB, 5.1, 18, 11.2);

// 3
s = p.addSlide(); base(s, { foot:"The live board is the proof", speaker:"Alvin · live" });
kicker(s, "Live · the board is the control plane");
title(s, [{text:"This is real. ",options:{color:INK}},{text:"Let's put one task through it.",options:{color:AMBB}}], 1.35, 32, 7.2);
card(s, { x:ML, y:2.7, w:6.35, h:3.7, items:[
  [{text:"The live board",bold:true},{text:" — real stations, your work moving left to right."}],
  [{text:"Take one task down the line",bold:true},{text:" and watch a worker pick it up."}],
  [{text:"A different agent reviews",bold:true},{text:" the work than the one that built it."}],
  [{text:"The delivery station",bold:true},{text:" follows your deploy pipeline and updates the task in your source system when that integration is configured."}],
], fs:13.5, gap:9 });
card(s, { x:7.55, y:2.7, w:4.86, h:3.7, accent:PUR });
s.addShape(p.shapes.ROUNDED_RECTANGLE,{x:7.9,y:3.0,w:1.9,h:0.44,rectRadius:0.22,fill:{color:"11241A"},line:{color:GREEN,width:1}});
s.addText("● LIVE DEMO",{x:7.9,y:3.0,w:1.9,h:0.44,fontFace:MONO,fontSize:11,bold:true,color:GREEN,align:"center",valign:"middle",margin:0});
s.addText("\"If it's not on the board, it didn't happen.\" The board is the control plane — not just a UI.",
  {x:7.9,y:3.65,w:4.2,h:1.0,fontFace:SANS,fontSize:14,color:"E3DFEA",margin:0,lineSpacingMultiple:1.1});
s.addText("The first reporting layer is the board itself — the same lifecycle that controls the work.",
  {x:7.9,y:4.75,w:4.2,h:1.1,fontFace:SANS,fontSize:13,color:MUT,margin:0,lineSpacingMultiple:1.1});

// 4
s = p.addSlide(); base(s, { foot:"Agentic engineering needs process, not just models", speaker:"Alvin" });
kicker(s, "Stations, not a black box");
title(s, [{text:"Process is built in — ",options:{color:INK}},{text:"not promised afterward",options:{color:AMBB}}], 1.35, 33);
card(s, { x:ML, y:2.7, w:5.55, h:2.85, head:"How AI is usually sold", items:["Task → Solved","One black box in the middle","Quality = hope"], fs:14, gap:10 });
card(s, { x:6.7, y:2.7, w:5.71, h:2.85, accent:PUR, head:"How AgentFactory runs", items:[
  [{text:"Understand → Spec → Build → Review → Deliver",bold:true}],
  "Each station: a fixed instruction + a quality gate",
  [{text:"An isolated git worktree",bold:true},{text:" per task; a reviewable diff against the merge-base"}],
  "A different agent reviews; a human checkpoint before delivery",
], fs:12.5, gap:6 });
closer(s, "Quality lives in the stations, gates and review loop — not only in the model.", PURB, 5.85, 17);

// 5
s = p.addSlide(); base(s, { foot:"The enterprise-relevant core", speaker:"Alvin" });
kicker(s, "The control model");
title(s, [{text:"Agents ",options:{color:INK}},{text:"cannot approve their own work",options:{color:AMBB}}], 1.35, 33);
const stages=[["start","backlog"],["human","queued"],["dispatcher","in_progress"],["agent","in_review"],["human ✓","delivering"],["watcher","done"]];
let bx=ML, bw=1.62, gap=0.35, by=2.55, bh=0.95;
stages.forEach((st,i)=>{
  const isDone=i===stages.length-1;
  s.addShape(p.shapes.ROUNDED_RECTANGLE,{x:bx,y:by,w:bw,h:bh,rectRadius:0.09,fill:{color:CARD},line:{color:isDone?GREEN:LINE,width:1}});
  s.addText([{text:st[0].toUpperCase(),options:{color:isDone?GREEN:PURB,fontSize:8.5,breakLine:true,fontFace:MONO}},
             {text:st[1],options:{color:INK,fontSize:13,bold:true,fontFace:SANS}}],
    {x:bx,y:by,w:bw,h:bh,align:"center",valign:"middle",margin:0});
  if(i<stages.length-1) s.addText("→",{x:bx+bw,y:by,w:gap,h:bh,fontFace:SANS,fontSize:16,bold:true,color:PUR,align:"center",valign:"middle",margin:0});
  bx+=bw+gap;
});
const cw3=(W-0.8)/3;
[["Enforced lifecycle","State changes are declared edges keyed by (from, to, by). Agents can't invent tasks or skip steps."],
 ["Human review gate","Approve, reopen, force-complete are human-only. An agent can never approve, force-complete or delete its own work."],
 ["Verified delivery","A watcher confirms the PR is merged and CI is green — or it goes back to the queue. \"Done\" is not self-declared."]]
.forEach((c,i)=>{ card(s,{x:ML+i*(cw3+0.4),y:3.95,w:cw3,h:2.3,head:c[0],body:c[1],fs:12.5}); });

// 6
s = p.addSlide(); base(s, { foot:"Honest maturity, not overselling", speaker:"Alvin" });
kicker(s, "Where it is today — honestly");
title(s, [{text:"A strong control model — ",options:{color:INK}},{text:"not yet an enterprise platform",options:{color:AMBB}}], 1.35, 31);
card(s, { x:ML, y:2.7, w:5.55, h:2.75, accent:PUR, head:"Strong today", items:[
  "Local-first; simple single-file datastore for the current prototype",
  "MCP interface; one isolated git worktree per task",
  "Reviewer loop; enforced human review gate",
  "Azure DevOps / GitHub delivery bridge"], fs:12.5, gap:6 });
card(s, { x:6.7, y:2.7, w:5.71, h:2.75, accent:AMB, head:"Not yet", items:[
  "Single-user / operator-controlled — no SSO or RBAC",
  "No exportable audit log or retention policy",
  "No enterprise database / deployment profile yet",
  "Basic observability; no policy-by-risk"], fs:12.5, gap:6 });
closer(s, "Everything shown today runs now; the enterprise hardening is exactly what we propose to scope together.", PURB, 5.75, 16.5);

// 7
s = p.addSlide(); base(s, { foot:"The joint hardening roadmap", speaker:"Alvin" });
kicker(s, "What we'd harden together");
title(s, [{text:"The enterprise-readiness backlog",options:{color:INK}}], 1.3, 30);
const hrows=[["Area","Current strength","Enterprise hardening needed"],
 ["Identity","Local / operator-controlled","SSO/OIDC, RBAC, approval roles"],
 ["Audit","Board history + task activity","Exportable audit log, retention policy"],
 ["Security","Worktree isolation, no direct agent-to-task-source coupling","Secrets vault, least-privilege tokens, threat model"],
 ["Deployment","Local-first","Docker / Kubernetes, backup, upgrade path"],
 ["Governance","Human review gate","Policy by task type, repo, risk level"],
 ["Model control","Human-supervised use","Approved model list, data-boundary policy, prompt/tool policy"],
 ["Observability","Board + token metrics","Enterprise logging, alerts, dashboards"],
 ["Compliance","Human-supervised workflow","DPA, data-flow docs, model/data policy"]];
const htab=hrows.map((r,ri)=> r.map((c,ci)=>({ text:c, options:{
  fill:{color:ri===0?"1C1826":CARD}, color: ri===0?MUT:(ci===0?INK:(ci===2?AMBB:MUT)),
  bold: ri===0||ci===0, fontFace: ri===0?MONO:SANS, fontSize: ri===0?10:11.5,
  align:"left", valign:"middle", margin:[3,6,3,6] }})));
s.addTable(htab, { x:ML, y:2.15, w:W, colW:[2.05,4.34,5.1], rowH:0.4, border:{type:"solid",pt:0.5,color:LINE}, autoPage:false });
s.addText("We're showing you the gaps on purpose. That honesty is the basis for a partnership — and the backlog for the pilot.",
  { x:ML, y:6.25, w:11.2, h:0.5, fontFace:SANS, fontSize:13.5, italic:true, color:"E3DFEA", margin:0 });

// 8
s = p.addSlide(); base(s, { foot:"Why it matters: portability and ownership", speaker:"Alvin / Poul" });
kicker(s, "Portability · no lock-in");
title(s, [{text:"You own the process — ",options:{color:INK}},{text:"even if we operate it",options:{color:AMBB}}], 1.35, 32);
card(s, { x:ML, y:2.7, w:5.85, h:2.9, accent:PUR, head:"ALP — the open protocol", items:[
  "Stations, lines and gates as an open protocol",
  [{text:"Your station definitions in plain text",bold:true},{text:" — you own them"}],
  "Audit history in git — portable",
  "No lock-in, no migration; take your process with you"], fs:12.5, gap:6 });
card(s, { x:7.0, y:2.7, w:5.41, h:2.9, head:"AgentFactory — the implementation", items:[
  "The running system, built on ALP",
  "What you saw in the demo",
  "Operated by us — or, after hardening, by you"], fs:13, gap:9 });
closer(s, "Like git and GitHub: the protocol is portable; the operated service is optional.", PURB, 5.9, 17);

// 9
s = p.addSlide(); base(s, { foot:"Co-build first · operate optionally", speaker:"Alvin + Poul" });
kicker(s, "How we'd collaborate · same AgentFactory foundation");
title(s, [{text:"Two ways to collaborate — ",options:{color:INK}},{text:"same foundation",options:{color:AMBB}}], 1.3, 30);
card(s, { x:ML, y:2.35, w:5.85, h:3.35, accent:PUR, head:"Track A · Enterprise co-build pilot",
  best:"Best if you want AgentFactory hardened for your environment.", items:[
  "Six-month, fixed-scope pilot",
  "One real backlog slice — or a greenfield product area",
  "Harden together: SSO/RBAC, deployment, audit, security model, operating procedures",
  "You own the requirements, process definitions and operational learning",
  "At the end: continue together, operate it yourselves, or stop — no lock-in"], fs:12, gap:5 });
card(s, { x:7.0, y:2.35, w:5.41, h:3.35, accent:AMB, head:"Track B · Operated factory line (optional)",
  best:"Best if you want throughput while the platform matures.", items:[
  "We set up and operate a line for selected tasks",
  "You keep the approval gates and source-system ownership",
  "We provide line management, monitoring and rework handling",
  "Can run alongside the co-build pilot as a practical proof point"], fs:12, gap:6 });
closer(s, "The question for today: which collaboration model is the safest first step for you?", PURB, 5.95, 16.5);

// 10
s = p.addSlide(); base(s, { foot:"A concrete, low-risk first step", speaker:"Alvin + Poul" });
kicker(s, "Next step");
title(s, [{text:"What we'd need to ",options:{color:INK}},{text:"start",options:{color:AMBB}}], 1.3, 32);
const asks=[["One backlog source","A real queue we can connect to — Jira, Azure DevOps or a backlog slice."],
 ["Three low-risk candidate tasks","Concrete first tasks to run the line end to end."],
 ["One technical / security contact","To scope the hardening backlog against your controls."],
 ["One business sponsor","To own success criteria and the decision at six months."],
 ["Agree the pilot shape","Greenfield or backlog slice; scope and gates, with success measures: cycle time, clean pass rate, rework rate, human-override rate."],
 ["A shared decision point","At six months: continue, take it over, or stop — no lock-in."]];
const cw=(W-0.8)/3;
asks.forEach((a,i)=>{ const col=i%3, row=Math.floor(i/3);
  card(s,{x:ML+col*(cw+0.4),y:2.35+row*1.72,w:cw,h:1.55,head:null,accent:(i===5?PUR:null)});
  s.addText(a[0],{x:ML+col*(cw+0.4)+0.32,y:2.35+row*1.72+0.24,w:cw-0.6,h:0.55,fontFace:SANS,fontSize:14,bold:true,color:INK,margin:0,lineSpacingMultiple:1.0});
  s.addText(a[1],{x:ML+col*(cw+0.4)+0.32,y:2.35+row*1.72+0.82,w:cw-0.6,h:0.65,fontFace:SANS,fontSize:11.5,color:MUT,margin:0,lineSpacingMultiple:1.05});
});
closer(s, "A first controlled line can run quickly; enterprise hardening is the six-month collaboration.", PURB, 5.95, 16.5);

// 11
s = p.addSlide(); base(s, { foot:"Technical deep-dive backup", speaker:"Alvin · if asked", appx:true });
kicker(s, "Architecture", 1.0);
title(s, [{text:"How it's ",options:{color:INK}},{text:"built",options:{color:PURB}}], 1.4, 32);
const arch=[["One DB owner","Six packages, npm workspaces, strict TypeScript. A single package owns the datastore and every lifecycle rule — the state machine lives in one place."],
 ["Three supervisors","Dispatcher spawns one fresh agent session per queued task. Reviewer posts an advisory second-agent verdict. Watcher verifies delivery on the git host over REST — no LLM."],
 ["Local & isolated","Task state is a local datastore; each task runs in its own git worktree. Nothing about the work has to leave your network."]];
arch.forEach((c,i)=>{ card(s,{x:ML+i*(cw3+0.4),y:2.75,w:cw3,h:2.6,head:c[0],body:c[1],fs:12.5}); });
s.addText("For deep IT or compliance questions, we propose a separate technical review of the ALP spec and control model with your security team.",
  { x:ML, y:5.6, w:11.2, h:0.6, fontFace:SANS, fontSize:13, italic:true, color:"E3DFEA", margin:0 });

// 12
s = p.addSlide(); base(s, { foot:"Optional operating model", speaker:"Poul · if asked", appx:true });
kicker(s, "The operated line, in detail", 1.0);
title(s, [{text:"Capacity you can dial — ",options:{color:INK}},{text:"under your gates",options:{color:PURB}}], 1.4, 31);
card(s, { x:ML, y:2.8, w:6.35, h:3.0, items:[
  [{text:"A line-manager",bold:true},{text:" watches the board, catches stuck tasks and handles rework, with a team behind them."}],
  "Capacity is one dial: add a line for more parallel throughput; pause and keep the backlog and definitions.",
  "You keep the approval gates and own the source system throughout."], fs:13.5, gap:9 });
card(s, { x:7.55, y:2.8, w:4.86, h:3.0, accent:AMB, head:"How we'd measure it" });
s.addText([{text:"Agent work can continue asynchronously; ",options:{color:"E3DFEA"}},{text:"approvals stay in your working hours and under your control.",options:{color:INK,bold:true}}],
  {x:7.9,y:3.65,w:4.2,h:1.1,fontFace:SANS,fontSize:13.5,margin:0,lineSpacingMultiple:1.12});
s.addText([{text:"We track ",options:{color:"E3DFEA"}},{text:"clean pass rate, rework rate and human-override rate",options:{color:INK,bold:true}},{text:" straight from the board — no separate report.",options:{color:"E3DFEA"}}],
  {x:7.9,y:4.75,w:4.2,h:1.0,fontFace:SANS,fontSize:13.5,margin:0,lineSpacingMultiple:1.12});

// 13
s = p.addSlide(); base(s, { foot:"Strategic framing — optional", speaker:"Alvin / Poul · if time", appx:true });
kicker(s, "The transition · L1 → L5", 1.0);
title(s, [{text:"You move up the levels by ",options:{color:INK}},{text:"tightening or loosening a gate",options:{color:PURB}}], 1.4, 28);
const lv=[["1","Assisted","Human writes; AI autocompletes.",false],["2","Copilot","AI on a task under constant steering.",false],
 ["3","Bounded","Whole tasks in guardrails; human approves each.",true],["4","Orchestrated","Many tasks in parallel; review by exception.",true],
 ["5","Self-delivering","Queue → verified delivery, minimal human touch.",true]];
const lw=(W-4*0.3)/5;
lv.forEach((l,i)=>{ const x=ML+i*(lw+0.3);
  s.addShape(p.shapes.ROUNDED_RECTANGLE,{x,y:2.75,w:lw,h:2.0,rectRadius:0.1,fill:{color:l[3]?"171233":CARD},line:{color:l[3]?PUR:LINE,width:1}});
  s.addText(l[0],{x:x+0.25,y:2.9,w:lw-0.5,h:0.5,fontFace:MONO,fontSize:22,bold:true,color:l[3]?PURB:MUT,margin:0});
  s.addText(l[1],{x:x+0.25,y:3.42,w:lw-0.5,h:0.35,fontFace:SANS,fontSize:12.5,bold:true,color:INK,margin:0});
  s.addText(l[2],{x:x+0.25,y:3.8,w:lw-0.45,h:0.9,fontFace:SANS,fontSize:10.5,color:MUT,margin:0,lineSpacingMultiple:1.05});
});
s.addText("Autonomy is a property of the deployment, not the model. A pilot starts at L3 — review everything — and earns its way toward L4/L5 as trust builds. Aligned to the Context& AI Transition model.",
  { x:ML, y:5.1, w:11.2, h:0.9, fontFace:SANS, fontSize:13, italic:true, color:"E3DFEA", margin:0, lineSpacingMultiple:1.1 });

// 14
s = p.addSlide(); base(s, { foot:"Our market thesis", speaker:"Poul · if asked", appx:true });
kicker(s, "Market thesis · from hours to factories", 1.0);
title(s, [{text:"Why the delivery model is ",options:{color:INK}},{text:"changing",options:{color:PURB}}], 1.4, 31);
s.addText("When AI accelerates the work itself, every task shrinks — and a business that sells hours × people shrinks with it. When delivery is no longer measured in time, the question changes: not how many hours, but what got delivered.",
  { x:ML, y:2.85, w:6.5, h:2.4, fontFace:SANS, fontSize:15.5, color:MUT, margin:0, lineSpacingMultiple:1.18 });
card(s, { x:7.55, y:2.8, w:4.86, h:2.9, accent:AMB, head:"The shift", items:[
  [{text:"From",bold:true},{text:" estimate, staff, invoice time"}],
  [{text:"To",bold:true},{text:" fixed price on bounded deliveries"}],
  [{text:"To",bold:true},{text:" a subscription on running capacity"}],
  "Scale up and down like cloud — not like hiring"], fs:12.5, gap:7 });
s.addText("Context for our commercial model — not the reason for today's meeting. Today is about co-building an enterprise-ready platform.",
  { x:ML, y:5.85, w:11.2, h:0.6, fontFace:SANS, fontSize:13, italic:true, color:"E3DFEA", margin:0 });

// 15
s = p.addSlide(); base(s, { foot:"Illustrative — your own estimate converts the same way", speaker:"Poul · if asked", appx:true });
kicker(s, "Operated-line pricing · illustrative", 1.0);
title(s, [{text:"The operated line — indicative pricing",options:{color:INK}}], 1.35, 27);
const prows=[["Capacity","List price (anchor)","What you get"],
 ["1 line","from 40,000 kr/mo","Board, operation and a line-manager — plus architect / workshop / discovery hours"],
 ["More lines","same anchor per line","Parallel capacity on the same board"],
 ["Pause","small standby fee","Backlog, context and definitions preserved — restart is one click"]];
const ptab=prows.map((r,ri)=> r.map((c,ci)=>({ text:c, options:{
  fill:{color:ri===0?"1C1826":CARD}, color: ri===0?MUT:(ci===0?INK:(ci===1?AMBB:MUT)),
  bold: ri===0||ci===0||ci===1, fontFace: ri===0?MONO:SANS, fontSize: ri===0?10:12.5,
  align:"left", valign:"middle", margin:[4,6,4,6] }})));
s.addTable(ptab, { x:ML, y:2.15, w:W, colW:[2.4,3.2,5.89], rowH:0.5, border:{type:"solid",pt:0.5,color:LINE}, autoPage:false });
const roiY=4.55;
s.addShape(p.shapes.ROUNDED_RECTANGLE,{x:ML,y:roiY,w:5.0,h:1.55,rectRadius:0.1,fill:{color:CARD},line:{color:LINE,width:1}});
s.addText([{text:"ILLUSTRATIVE · CLASSIC TEAM",options:{color:MUT,fontSize:9.5,fontFace:MONO,breakLine:true}},
  {text:"≈ 3.0M kr",options:{color:INK,fontSize:24,bold:true,fontFace:SANS,breakLine:true}},
  {text:"2,000 hours · classic hourly rate — customer carries estimate risk",options:{color:MUT,fontSize:10.5,fontFace:SANS}}],
  {x:ML+0.3,y:roiY+0.2,w:4.5,h:1.2,margin:0,valign:"top",lineSpacingMultiple:1.05});
s.addText("÷ 2",{x:ML+5.0,y:roiY,w:1.49,h:1.55,fontFace:SANS,fontSize:18,bold:true,color:PURB,align:"center",valign:"middle",margin:0});
s.addShape(p.shapes.ROUNDED_RECTANGLE,{x:ML+6.49,y:roiY,w:5.0,h:1.55,rectRadius:0.1,fill:{color:CARD},line:{color:AMB,width:1.5}});
s.addText([{text:"ILLUSTRATIVE · ON LINES",options:{color:AMBB,fontSize:9.5,fontFace:MONO,breakLine:true}},
  {text:"≈ 1.5M kr",options:{color:AMBB,fontSize:24,bold:true,fontFace:SANS,breakLine:true}},
  {text:"Same calendar time · lines + architect hours",options:{color:MUT,fontSize:10.5,fontFace:SANS}}],
  {x:ML+6.79,y:roiY+0.2,w:4.5,h:1.2,margin:0,valign:"top",lineSpacingMultiple:1.05});
s.addText("Round anchors, not a quote — and part of the operated track, not the co-build pilot. Method: classic estimate → halve → compose lines + add-ons.",
  { x:ML, y:6.25, w:11.2, h:0.5, fontFace:SANS, fontSize:12, italic:true, color:"E3DFEA", margin:0 });

p.writeFile({ fileName: "AgentFactory-CoBuild.pptx" }).then(f=>console.log("WROTE", f));
