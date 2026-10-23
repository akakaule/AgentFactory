import type { AgentModelsView, ModelProfile, ReportedProfile, WorkspaceModelLayer } from '../types.js';
import {
  MAX_REVIEWERS, ROLE_LABEL, describeProfile, fileDefault, getRole, modelIdError, otherEngine, reviewerListError, toProfile, withRole,
  type ProfileRole,
} from '../agentModelMeta.js';
import { ModelProfileEditor } from './ModelProfileEditor.js';

const STEPS = 5; // spec, implementation, review, visualization, feedback evaluator

/** Workspaces › Edit › Agent models: per-role overrides of the board's global model settings. A
 *  review override is the WHOLE reviewer list (decision 5); ticking it copies the global list. */
export function WorkspaceAgentModels({ view, draft, onChange }: {
  view: AgentModelsView;
  draft: WorkspaceModelLayer;
  onChange: (next: WorkspaceModelLayer) => void;
}) {
  const global = view.settings.global;
  const catalog = view.catalog;

  // what the workspace inherits for a role: the board global, else the config files' default
  const inherited = (role: ProfileRole): { profile: ModelProfile; text: string } => {
    const g = getRole(global, role);
    if (g) return { profile: g, text: describeProfile(g, catalog) };
    const d = fileDefault(view.defaults, role);
    if (d.kind === 'one') { const p = toProfile(d.value as ReportedProfile); return { profile: p, text: `${describeProfile(p, catalog)} (config file)` }; }
    return { profile: { engine: 'claude' }, text: d.kind === 'varies' ? 'config files (varies by supervisor)' : 'config file' };
  };
  const inheritedReviewers = (): { list: ModelProfile[]; text: string } => {
    if (global.reviewers) return { list: global.reviewers, text: global.reviewers.map((p) => describeProfile(p, catalog)).join(' + ') };
    const d = fileDefault(view.defaults, 'reviewers');
    if (d.kind === 'one') {
      const list = (d.value as ReportedProfile[]).map(toProfile);
      return { list, text: `${list.map((p) => describeProfile(p, catalog)).join(' + ')} (config file)` };
    }
    return { list: [{ engine: 'codex' }], text: d.kind === 'varies' ? 'config files (varies by supervisor)' : 'config file' };
  };

  const overridden = (['description', 'implementation', 'visualization', 'feedbackEval'] as const).filter((r) => getRole(draft, r)).length
    + (draft.reviewers ? 1 : 0);

  const profileRow = (role: ProfileRole) => {
    const own = getRole(draft, role);
    const inh = inherited(role);
    return (
      <div key={role} className="af-wsm-row">
        <div className="af-wsm-row-h">
          <strong>{ROLE_LABEL[role]}</strong>
          {!own && <span className="af-wsm-uses">Uses global: {inh.text}</span>}
          <label>
            <input type="checkbox" aria-label={`Override ${ROLE_LABEL[role]} for this workspace`} checked={own !== undefined}
              onChange={(e) => onChange(withRole(draft, role, e.target.checked ? inh.profile : undefined))} />
            Override for this workspace
          </label>
        </div>
        {own && <ModelProfileEditor label={`Workspace ${ROLE_LABEL[role]}`} value={own} catalog={catalog} onChange={(p) => onChange(withRole(draft, role, p))} />}
      </div>
    );
  };

  const reviewers = draft.reviewers;
  const inhR = inheritedReviewers();
  const listErr = reviewers ? reviewerListError(reviewers) : null;
  const setReviewers = (list: ModelProfile[] | undefined) => {
    const next = { ...draft };
    if (list) next.reviewers = list; else delete next.reviewers;
    onChange(next);
  };

  return (
    <details style={{ marginTop: '2px' }}>
      <summary style={{ fontSize: '12px', color: 'var(--ink-3)', cursor: 'pointer' }}>
        Agent models — {overridden} of {STEPS} steps overridden
      </summary>
      <div style={{ marginTop: '6px' }}>
        {profileRow('description')}
        {profileRow('implementation')}
        <div className="af-wsm-row">
          <div className="af-wsm-row-h">
            <strong>Review</strong>
            {!reviewers && <span className="af-wsm-uses">Uses global: {inhR.text}</span>}
            <label>
              <input type="checkbox" aria-label="Override Review for this workspace" checked={reviewers !== undefined}
                onChange={(e) => setReviewers(e.target.checked ? inhR.list : undefined)} />
              Override for this workspace
            </label>
          </div>
          {reviewers?.map((p, i) => (
            <div key={i} className="af-mcard-reviewer">
              <div className="af-mcard-reviewer-h">
                <span>Reviewer {i + 1}</span>
                <button type="button" className="af-mini danger" disabled={reviewers.length <= 1} onClick={() => setReviewers(reviewers.filter((_, j) => j !== i))}>Remove</button>
              </div>
              <ModelProfileEditor label={`Workspace reviewer ${i + 1}`} value={p} catalog={catalog} onChange={(next) => setReviewers(reviewers.map((r, j) => (j === i ? next : r)))} />
            </div>
          ))}
          {listErr && <div className="af-err" role="alert">{listErr}</div>}
          {reviewers && (
            <div>
              <button type="button" className="af-mini" disabled={reviewers.length >= MAX_REVIEWERS}
                onClick={() => setReviewers([...reviewers, { engine: otherEngine(reviewers.at(-1)?.engine ?? 'claude') }])}>
                + Add reviewer
              </button>
            </div>
          )}
        </div>
        <details>
          <summary style={{ fontSize: '12px', color: 'var(--ink-3)', cursor: 'pointer', padding: '6px 0' }}>Other agents</summary>
          {profileRow('visualization')}
          {profileRow('feedbackEval')}
        </details>
      </div>
    </details>
  );
}

/** Whether a workspace draft can be saved (model ids and the reviewer list are valid). */
export function workspaceModelsValid(draft: WorkspaceModelLayer): boolean {
  const profiles = [draft.stages?.description, draft.stages?.implementation, draft.visualization, draft.feedbackEval];
  return profiles.every((p) => modelIdError(p?.model) === null) && (!draft.reviewers || reviewerListError(draft.reviewers) === null);
}
