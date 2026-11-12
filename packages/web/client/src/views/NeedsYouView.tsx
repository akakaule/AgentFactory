import { useMemo, useState } from 'react';
import type { Task } from '../types.js';
import { api } from '../api.js';
import { needsYou, canQuickApprove, type Need, type NeedKind } from '../needsYou.js';
import { useSupervisors } from '../useSupervisors.js';
import { AnswerForm } from '../components/AnswerForm.js';
import { STAGE_LABELS } from '../status.js';
import { shortTime } from '../time.js';

const CHIP: Record<NeedKind, { label: (t: Task) => string; cls: string }> = {
  question: { label: (t) => (t.block?.decision ? 'Agent asks' : 'Blocked'), cls: 'q' },
  review: { label: (t) => (t.kind === 'pr-review' ? 'Review the PR' : t.stage === 'implementation' ? 'Review the change' : 'Review the spec'), cls: 'r' },
  attempts: { label: () => 'Out of attempts', cls: 'a' },
  setup: { label: () => 'Needs setup', cls: 'a' },
  delivery: { label: () => 'Delivery stuck', cls: 'd' },
  spec: { label: () => 'Spec flagged', cls: 's' },
};

/**
 * Every task waiting on the human, each with the decision it needs and the options for it.
 * Derived from task state (needsYou.ts): acting on a card moves the task, which drops the card —
 * there is nothing to dismiss. Supervisor outages show as a banner, not as task cards.
 */
export function NeedsYouView({ tasks, multiWs, onOpen, onChanged }: { tasks: Task[]; multiWs: boolean; onOpen: (key: string) => void; onChanged: () => void }) {
  const items = useMemo(() => needsYou(tasks), [tasks]);
  const supervisors = useSupervisors();
  const down = supervisors.filter((s) => !s.healthy);
  const oldest = items.reduce<string | null>((o, n) => (o === null || n.since < o ? n.since : o), null);

  return (
    <div className="af-ny">
      {down.length > 0 && (
        <div role="status" className="af-ny-banner">
          <strong>{down.map((s) => s.name).join(', ')} {down.length === 1 ? 'is' : 'are'} offline.</strong>{' '}
          Work that needs {down.length === 1 ? 'it' : 'them'} waits until {down.length === 1 ? 'it is' : 'they are'} back — restart the supervisor.
        </div>
      )}
      <div className="af-ny-layout">
        <main className="af-ny-main">
          <div className="af-ny-head">
            <h2>Needs you</h2>
            <span className="af-ny-sub">
              {items.length === 0 ? 'Nothing is waiting on you.' : `${items.length} ${items.length === 1 ? 'decision' : 'decisions'} · oldest waiting ${shortTime(oldest!)}`}
            </span>
          </div>
          {items.map((n) => <NeedCard key={`${n.task.key}:${n.kind}`} need={n} multiWs={multiWs} onOpen={onOpen} onChanged={onChanged} />)}
          {items.length > 0 && <p className="af-ny-foot">A card leaves this list by itself when its task moves on.</p>}
        </main>
        <AllWork tasks={tasks} needs={items} onOpen={onOpen} />
      </div>
    </div>
  );
}

function NeedCard({ need, multiWs, onOpen, onChanged }: { need: Need; multiWs: boolean; onOpen: (key: string) => void; onChanged: () => void }) {
  const { task: t, kind } = need;
  const chip = CHIP[kind];
  const title = kind === 'question' && t.block?.decision ? t.block.decision.question : t.title;
  return (
    <article className="af-ny-card" aria-label={`${t.key} ${chip.label(t)}`}>
      <div className="af-ny-meta">
        <span className={`af-ny-chip ${chip.cls}`}>{chip.label(t)}</span>
        <button className="af-ny-key" onClick={() => onOpen(t.key)}>{t.key}</button>
        <span className="af-ny-dim">{multiWs ? `${t.workspace} · ` : ''}{STAGE_LABELS[t.stage]}{kind === 'question' && t.block?.decision ? ` · ${t.title}` : ''}</span>
        <span className="af-ny-grow" />
        <span className="af-ny-dim">waiting {shortTime(need.since)}</span>
      </div>
      <h3 className="af-ny-title">{title}</h3>
      {kind === 'question' && <QuestionBody task={t} onOpen={onOpen} onChanged={onChanged} />}
      {kind === 'review' && <ReviewBody task={t} onOpen={onOpen} onChanged={onChanged} />}
      {(kind === 'attempts' || kind === 'setup') && <RecoverBody task={t} setup={kind === 'setup'} onOpen={onOpen} onChanged={onChanged} />}
      {kind === 'delivery' && <DeliveryBody task={t} since={need.since} onOpen={onOpen} />}
      {kind === 'spec' && <SpecBody task={t} onOpen={onOpen} />}
    </article>
  );
}

function QuestionBody({ task: t, onOpen, onChanged }: { task: Task; onOpen: (key: string) => void; onChanged: () => void }) {
  const reason = t.block?.reason;
  const showReason = reason && reason !== t.block?.decision?.question;
  return (
    <>
      {showReason ? <p className="af-ny-text-p">{reason}</p> : !t.block?.decision && !reason && <p className="af-ny-text-p muted">The agent did not say why. Open the task to read its log.</p>}
      <AnswerForm taskKey={t.key} block={t.block} onDone={onChanged} />
      <div className="af-ny-actions"><button className="af-mini" onClick={() => onOpen(t.key)}>Open task</button></div>
    </>
  );
}

function ReviewBody({ task: t, onOpen, onChanged }: { task: Task; onOpen: (key: string) => void; onChanged: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ai = t.aiReview;
  const criteria = t.reviewBrief?.criteria ?? [];
  const met = criteria.filter((c) => c.status === 'clear').length;
  const sha = t.submission?.headSha?.slice(0, 7) ?? null;
  const quick = canQuickApprove(t);
  const aiText = !ai ? 'No AI review yet'
    : ai.binding === 'unverified' ? 'No review can prove this revision'
    : ai.verdict === 'clean' ? 'AI review: no findings'
    : ai.verdict === 'pending' ? 'AI review pending'
    : `AI review: ${ai.findings} ${ai.findings === 1 ? 'finding' : 'findings'}${ai.verdict === 'disputed' ? ' (reviewers disagree)' : ''}`;
  const approve = async () => {
    if (!t.submission) return;
    setBusy(true); setError(null);
    try { await api.approve(t.key, undefined, { submissionId: t.submission.id, headSha: t.submission.headSha }); onChanged(); }
    catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      <div className="af-ny-facts">
        {t.kind !== 'pr-review' && <span className={'af-ny-fact' + (ai?.verdict === 'clean' && ai.binding === 'current' ? ' good' : '')}>{aiText}</span>}
        {criteria.length > 0 && <span className={'af-ny-fact' + (met === criteria.length ? ' good' : '')}>{met} of {criteria.length} criteria met</span>}
        {t.submission && <span className="af-ny-fact mono">submission #{t.submission.id}{sha ? ` · ${sha}` : ''}</span>}
      </div>
      {quick && <p className="af-ny-text-p">Approving sends it to delivery: the PR is opened and merged once checks pass on {sha}.</p>}
      {error && <div role="alert" className="af-ny-error">{error}</div>}
      <div className="af-ny-actions">
        <button className="af-btn-primary" onClick={() => onOpen(t.key)}>Open the review</button>
        {quick && <button className="af-mini" disabled={busy} onClick={() => void approve()}>Approve {sha}</button>}
      </div>
    </>
  );
}

type RecoverChoice = 'restart' | 'note' | 'cancel';

function RecoverBody({ task: t, setup, onOpen, onChanged }: { task: Task; setup: boolean; onOpen: (key: string) => void; onChanged: () => void }) {
  const [choice, setChoice] = useState<RecoverChoice>(setup ? 'restart' : 'note');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const f = t.failure;
  const exhaustedDelivery = t.status === 'delivering' && t.delivery?.repairExhausted;
  const detail = exhaustedDelivery ? 'The delivery repair budget is spent: the PR failed again after the automatic fixes.'
    : f ? `${f.detail ?? f.reason}${f.attempt !== null && f.maxAttempts !== null ? ` · attempt ${f.attempt} of ${f.maxAttempts}` : ''}` : null;
  // Restart only applies to a skip-listed failure; a setup failure that still has attempts left retries by itself.
  const canRestart = !!(f?.skipListed || exhaustedDelivery);
  const options: Array<{ id: RecoverChoice; label: string; detail: string }> = [
    ...(canRestart ? [
      { id: 'restart' as const, label: 'Restart with a fresh budget', detail: setup ? 'After you have fixed the setup: credentials, permissions or tools.' : 'Try again as it is.' },
      { id: 'note' as const, label: 'Restart with a note', detail: 'Tell the next session what to do differently.' },
    ] : []),
    { id: 'cancel', label: 'Cancel the task', detail: 'Stops the work. You can reopen it later.' },
  ];
  const current = options.some((o) => o.id === choice) ? choice : options[0]!.id;
  const run = async () => {
    setBusy(true); setError(null);
    try {
      if (current === 'cancel') await api.setStatus(t.key, 'cancelled');
      else {
        if (current === 'note' && note.trim()) await api.addComment(t.key, note.trim());
        await api.restart(t.key);
      }
      onChanged();
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };
  return (
    <>
      {detail && <p className="af-ny-text-p"><span className="mono af-ny-err-text">{detail}</span>{t.failureTriage ? ` · likely cause: ${t.failureTriage.label}` : ''}</p>}
      {setup && !canRestart && <p className="af-ny-text-p">Fix the setup; the next automatic retry picks it up.</p>}
      <fieldset className="af-ny-options">
        <legend className="af-ny-sr">Choose what happens next</legend>
        {options.map((o) => (
          <label key={o.id} className={'af-ny-option' + (current === o.id ? ' on' : '')}>
            <input type="radio" name={`recover-${t.key}`} checked={current === o.id} onChange={() => setChoice(o.id)} />
            <span><span className="af-ny-option-label">{o.label}</span><span className="af-ny-option-detail">{o.detail}</span></span>
          </label>
        ))}
      </fieldset>
      {current === 'note' && (
        <textarea className="af-ny-text" aria-label="Note for the next session" rows={2} placeholder="e.g. raise the test timeout and mock the clock" value={note} onChange={(e) => setNote(e.target.value)} />
      )}
      {error && <div role="alert" className="af-ny-error">{error}</div>}
      <div className="af-ny-actions">
        <button className="af-btn-primary" disabled={busy || (current === 'note' && !note.trim())} onClick={() => void run()}>Do it</button>
        <button className="af-mini" onClick={() => onOpen(t.key)}>See the failures</button>
      </div>
    </>
  );
}

function DeliveryBody({ task: t, since, onOpen }: { task: Task; since: string; onOpen: (key: string) => void }) {
  const d = t.delivery;
  const failing = d?.failing ?? [];
  const text = d?.checksState === 'failing'
    ? `Checks failing${failing.length ? `: ${failing.map((c) => c.name).join(', ')}` : ''}.`
    : !d?.prUrl ? `No pull request yet after ${shortTime(since)} — check the watcher and the workspace token.`
    : `No change for ${shortTime(since)} (PR ${d.prState}, checks ${d.checksState}). A merge may be refused by branch protection.`;
  return (
    <>
      <p className="af-ny-text-p">{text}</p>
      <div className="af-ny-actions">
        {d?.prUrl && <a className="af-btn-primary" href={d.prUrl} target="_blank" rel="noreferrer">Open PR{d.prId ? ` #${d.prId}` : ''}</a>}
        <button className="af-mini" onClick={() => onOpen(t.key)}>Open task</button>
      </div>
    </>
  );
}

function SpecBody({ task: t, onOpen }: { task: Task; onOpen: (key: string) => void }) {
  const reasons = t.queueGate?.reasons ?? [];
  return (
    <>
      <p className="af-ny-text-p">Task Intelligence will not queue it{reasons.length ? `: ${reasons.map((r) => r.message).join('; ')}` : ''}. Edit the spec; it is re-assessed automatically.</p>
      <div className="af-ny-actions"><button className="af-btn-primary" onClick={() => onOpen(t.key)}>Edit the spec</button></div>
    </>
  );
}

/** Per-workspace summary beside the list: what is running, what waits on you. */
function AllWork({ tasks, needs, onOpen }: { tasks: Task[]; needs: Need[]; onOpen: (key: string) => void }) {
  const needKeys = new Set(needs.map((n) => n.task.key));
  const groups = new Map<string, Task[]>();
  for (const t of tasks) {
    if (t.archivedAt || t.status === 'done' || t.status === 'cancelled' || t.status === 'backlog') continue;
    groups.set(t.workspace, [...(groups.get(t.workspace) ?? []), t]);
  }
  const state = (t: Task) => needKeys.has(t.key) ? { label: 'Needs you', cls: 'you' }
    : t.status === 'in_progress' ? { label: 'Running', cls: 'run' }
    : t.status === 'in_review' ? { label: 'Reviewing', cls: 'rev' }
    : t.status === 'delivering' ? { label: 'Delivering', cls: 'del' }
    : { label: 'Queued', cls: 'q' };
  return (
    <aside className="af-ny-side" aria-label="All work">
      <h2>All work</h2>
      {groups.size === 0 && <p className="af-ny-dim">Nothing active.</p>}
      {[...groups.entries()].map(([ws, list]) => {
        const waiting = list.filter((t) => needKeys.has(t.key)).length;
        return (
          <section key={ws} className="af-ny-ws">
            <div className="af-ny-ws-head"><h3>{ws}</h3><span className="af-ny-dim">{waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : `${list.length} active`}</span></div>
            {list.map((t) => {
              const s = state(t);
              return (
                <button key={t.key} className="af-ny-ws-row" onClick={() => onOpen(t.key)}>
                  <span className="af-ny-ws-title"><span>{t.title}</span><span className="af-ny-dim">{t.key} · {STAGE_LABELS[t.stage]}</span></span>
                  <span className={`af-ny-state ${s.cls}`}>{s.label}</span>
                </button>
              );
            })}
          </section>
        );
      })}
    </aside>
  );
}
