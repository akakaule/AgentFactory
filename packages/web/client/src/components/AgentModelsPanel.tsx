import { useEffect, useState } from 'react';
import type { AgentModelLayer, AgentModelsView, EngineSettings, ModelProfile, ReportedProfile } from '../types.js';
import { api } from '../api.js';
import {
  MAX_REVIEWERS, ROLE_LABEL, engineOffNote, fileDefault, getRole, otherEngine, reviewerListError,
  reviewerOffNote, sourceText, toProfile, withRole, modelIdError, type ProfileRole,
} from '../agentModelMeta.js';
import { ModelProfileEditor } from './ModelProfileEditor.js';

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** The board's GLOBAL model settings, one card per pipeline step (Agents › Models). A step not set
 *  on the board shows what the supervisors' config files use; editing it sets it on the board.
 *  Save sends the whole document: this global layer plus the workspace overrides as freshly re-read. */
export function AgentModelsPanel({ engines, onClose }: { engines: EngineSettings | null; onClose: () => void }) {
  const [view, setView] = useState<AgentModelsView | null>(null);
  const [draft, setDraft] = useState<AgentModelLayer>({});
  const [saving, setSaving] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const load = (v: AgentModelsView) => { setView(v); setDraft(v.settings.global); };
  useEffect(() => { api.getAgentModels().then(load).catch((e: Error) => setErr(e.message)); }, []);

  if (!view) return <div style={{ color: 'var(--ink-3)' }}>{err ? <span className="af-err">{err}</span> : 'Loading…'}</div>;

  const loaded = view.settings.global;
  const catalog = view.catalog;
  const roles: ProfileRole[] = ['description', 'implementation', 'visualization', 'feedbackEval'];
  const unsaved = roles.filter((r) => !same(getRole(draft, r), getRole(loaded, r))).length
    + (same(draft.reviewers, loaded.reviewers) ? 0 : 1) + (same(draft.consensus, loaded.consensus) ? 0 : 1);
  const invalid = roles.some((r) => modelIdError(getRole(draft, r)?.model) !== null) || (draft.reviewers ? reviewerListError(draft.reviewers) !== null : false);

  const edit = (next: AgentModelLayer) => { setDraft(next); setSaved(false); };
  const save = (global: AgentModelLayer) => {
    setSaving(true);
    setErr(null);
    // re-read first and replace only the global layer, so a workspace override saved meanwhile
    // (another tab, the workspace editor) is kept rather than overwritten by this modal's stale copy
    api.getAgentModels()
      .then((fresh) => api.setAgentModels({ global, workspaces: fresh.settings.workspaces }))
      .then((v) => { load(v); setSaved(true); setConfirmReset(false); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  const profileCard = (role: ProfileRole, n?: number) => {
    const boardValue = getRole(draft, role);
    const d = fileDefault(view.defaults, role);
    const shown = boardValue ?? (d.kind === 'one' ? toProfile(d.value as ReportedProfile) : { engine: 'claude' as const });
    const extra = d.kind === 'one' ? (d.value as ReportedProfile).extraArgs : undefined;
    const note = engineOffNote(shown.engine, engines);
    return (
      <section key={role} className="af-mcard" aria-label={ROLE_LABEL[role]}>
        <header>
          <h4>{n !== undefined && <span className="af-mcard-n">{n}</span>}{ROLE_LABEL[role]}</h4>
          <span className={`af-chip${boardValue ? ' on' : ''}`}>{boardValue ? 'set on board' : sourceText(d)}</span>
          {boardValue && <button type="button" className="af-mini" onClick={() => edit(withRole(draft, role, undefined))}>Use config file</button>}
        </header>
        <ModelProfileEditor label={ROLE_LABEL[role]} value={shown} catalog={catalog} onChange={(p) => edit(withRole(draft, role, p))} />
        {!boardValue && extra && extra.length > 0 && (
          <p className="af-mcard-hint">The config file also passes <code className="mono">{extra.join(' ')}</code> for this step; setting it on the board drops those.</p>
        )}
        {note && <p className="af-mcard-warn" role="note">{note}</p>}
      </section>
    );
  };

  const reviewDefault = fileDefault(view.defaults, 'reviewers');
  const consensusDefault = fileDefault(view.defaults, 'consensus');
  const reviewers: ModelProfile[] = draft.reviewers
    ?? (reviewDefault.kind === 'one' ? (reviewDefault.value as ReportedProfile[]).map(toProfile) : [{ engine: 'codex' }]);
  const consensus = draft.consensus ?? (consensusDefault.kind === 'one' ? consensusDefault.value === true : false);
  const reviewSetOnBoard = draft.reviewers !== undefined || draft.consensus !== undefined;
  const listErr = reviewerListError(reviewers);
  const setReviewers = (list: ModelProfile[]) => edit({ ...draft, reviewers: list });

  return (
    <div className="af-models">
      <div className="af-models-cards">
        {profileCard('description', 1)}
        {profileCard('implementation', 2)}
        <section className="af-mcard" aria-label="Review">
          <header>
            <h4><span className="af-mcard-n">3</span>Review</h4>
            <span className={`af-chip${draft.reviewers ? ' on' : ''}`}>{draft.reviewers ? 'set on board' : sourceText(reviewDefault)}</span>
            {reviewSetOnBoard && (
              <button type="button" className="af-mini" onClick={() => { const { reviewers: _r, consensus: _c, ...rest } = draft; edit(rest); }}>Use config file</button>
            )}
          </header>
          {reviewers.map((p, i) => {
            const note = reviewerOffNote(reviewers, i, engines, catalog);
            return (
              <div key={i} className="af-mcard-reviewer">
                <div className="af-mcard-reviewer-h">
                  <span>Reviewer {i + 1}</span>
                  <button type="button" className="af-mini danger" disabled={reviewers.length <= 1} onClick={() => setReviewers(reviewers.filter((_, j) => j !== i))}>Remove</button>
                </div>
                <ModelProfileEditor label={`Reviewer ${i + 1}`} value={p} catalog={catalog} onChange={(next) => setReviewers(reviewers.map((r, j) => (j === i ? next : r)))} />
                {note && <p className="af-mcard-warn" role="note">{note}</p>}
              </div>
            );
          })}
          {listErr && <div className="af-err" role="alert">{listErr}</div>}
          <div className="af-mcard-foot">
            <button type="button" className="af-mini" disabled={reviewers.length >= MAX_REVIEWERS}
              onClick={() => setReviewers([...reviewers, { engine: otherEngine(reviewers.at(-1)?.engine ?? 'claude') }])}>
              + Add reviewer
            </button>
            <label>
              <input type="checkbox" checked={consensus} onChange={(e) => edit({ ...draft, consensus: e.target.checked })} /> Consensus round
            </label>
          </div>
        </section>
        <details className="af-mcard-more">
          <summary>Other agents</summary>
          {profileCard('visualization')}
          {profileCard('feedbackEval')}
          <p className="af-mcard-hint">Plan stage (legacy): same as Spec.</p>
        </details>
      </div>
      {err && <div className="af-err" style={{ marginTop: '8px' }}>{err}</div>}
      <footer className="af-models-foot">
        <span className="af-models-count">{unsaved > 0 ? `${unsaved} unsaved change${unsaved === 1 ? '' : 's'}` : saved ? 'Saved' : 'No unsaved changes'}</span>
        {confirmReset ? (
          <span className="af-models-confirm">
            Clear every global model setting and go back to the config files?
            <button type="button" className="af-mini danger" disabled={saving} onClick={() => save({})}>Reset</button>
            <button type="button" className="af-mini" onClick={() => setConfirmReset(false)}>Keep</button>
          </span>
        ) : (
          <button type="button" className="af-mini" disabled={saving} onClick={() => setConfirmReset(true)}>Reset to config files</button>
        )}
        <button type="button" className="af-mini" onClick={onClose}>Cancel</button>
        <button type="button" className="af-btn-primary" disabled={saving || unsaved === 0 || invalid} onClick={() => save(draft)}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
      <p className="af-mcard-hint">Applies to the next session each supervisor starts. Workspaces can override any step in their own settings.</p>
    </div>
  );
}
