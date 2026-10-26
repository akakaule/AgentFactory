import type { DB } from '../db.js';
import type { Task, TaskDetail, Status, Stage, TaskKind, UpdateTaskInput, AiReviewSummary, FailureSummary, IntakeSummary, Activity, FailureTriageFeedback, FailureTriageSummary, SubmissionSummary } from '../types.js';
import { RECENT_ACTIVITY_LIMIT } from '../types.js';
import { recentActivity, activitySteps, criteriaClaimsFor, latestAiReviewComments, latestFailureNotePairs, latestResultIds, latestRestartMarkerIds, intakeMarkerActivities, intakeMarkerActivitiesByTaskIds, failureTriageFeedbackActivities, type FailureNoteRow } from './activity.js';
import { linksFor } from './links.js';
import { RESERVED_BY_OTHER_SQL, reservedByOtherParams } from './execution.js';
import { attachmentsMeta } from './attachments.js';
import { visualizationMetaFor } from './visualizations.js';
import { latestSubmissionFor, reviewBinding, toSubmissionSummary, type DocContent } from './submissions.js';
import { deriveTaskMetrics } from '../metrics.js';
import { parseAiReviewComment, summarizeAiReview } from '../aiReview.js';
import { buildReviewBrief } from '../reviewBrief.js';
import { parseFailureComment, summarizeFailure, type ParsedFailure } from '../failure.js';
import { classifyFailureNote, parseFailureTriageFeedbackComment, summarizeFailureTriage } from '../failureTriage.js';
import { deliveryByTaskIds } from './delivery.js';
import { tokenAggregateFor, tokenBreakdownFor } from './metrics.js';
import { nowIso } from '../time.js';
import { dependenciesFor, dependentsFor } from './taskDependencies.js';
import { getKv } from './kv.js';
import { normalizeIntakeSettings, intakeEnabledFor } from '../intakeSettings.js';
import { evaluateIntakePolicy, intakeOverrideRevision, intakeRevision, parseIntakeComment, SKIP_SPEC_NOTE_PREFIX } from '../intake.js';

export interface TaskRow {
  id: number; key: string; title: string; spec: string; acceptance_criteria: string;
  status: Status; stage: Stage; kind: TaskKind; result_summary: string | null; seq: number; created_at: string; updated_at: string;
  workspace_id: number; workspace_name: string; workspace_repo_path: string;
  workspace_policy: string | null; workspace_verify_command: string | null;
  claimed_by: string | null; claimed_at: string | null; branch: string | null; plan: string | null;
  archived_at: string | null;
  original_spec: string | null; original_acceptance_criteria: string | null;
  unmet_dependency_count: number;
}

// every Task/TaskDetail payload carries the workspace slug (and repoPath + discipline on detail),
// so all task SELECTs go through this JOIN
const SELECT_TASK =
  `SELECT task.*, w.name AS workspace_name, w.repo_path AS workspace_repo_path,
          w.policy AS workspace_policy, w.verify_command AS workspace_verify_command,
          (SELECT COUNT(*)
           FROM task_dependency dependency
           JOIN task prerequisite ON prerequisite.id = dependency.depends_on_task_id
           WHERE dependency.task_id = task.id AND prerequisite.status != 'done') AS unmet_dependency_count
   FROM task JOIN workspace w ON w.id = task.workspace_id`;

// aiReview + failure are derived (latest ai-review / failure comment) and layered on by the
// DB-aware paths below; toTask itself is pure and defaults both to null.
export function toTask(r: TaskRow): Task {
  return {
    id: r.id, key: r.key, title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria,
    status: r.status, stage: r.stage, kind: r.kind, resultSummary: r.result_summary, seq: r.seq, workspace: r.workspace_name,
    unmetDependencyCount: r.unmet_dependency_count,
    claimedBy: r.claimed_by, claimedAt: r.claimed_at, archivedAt: r.archived_at, aiReview: null, reviewBrief: null, failure: null, failureTriage: null, delivery: null, intake: null,
    createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function storedIntakeSettings(db: DB): ReturnType<typeof normalizeIntakeSettings> {
  const raw = getKv(db, 'intake_settings');
  if (!raw) return normalizeIntakeSettings(null);
  try { return normalizeIntakeSettings(JSON.parse(raw) as unknown); } catch { return normalizeIntakeSettings(null); }
}

function intakeSummaryFromActivities(r: TaskRow, activities: ReturnType<typeof intakeMarkerActivities>, settings: ReturnType<typeof normalizeIntakeSettings>): IntakeSummary | null {
  if (!intakeEnabledFor(settings, r.workspace_name)) return null;
  const revision = intakeRevision({ title: r.title, spec: r.spec, acceptanceCriteria: r.acceptance_criteria, stage: r.stage, plan: r.plan });
  const parsed = activities
    .filter((a) => a.body.trimStart().toLowerCase().startsWith('intake/v1'))
    .map((a) => ({ activity: a, assessment: parseIntakeComment(a.body) }))
    .filter((x): x is { activity: (typeof activities)[number]; assessment: NonNullable<ReturnType<typeof parseIntakeComment>> } => x.assessment !== null);
  const current = parsed.find((x) => x.assessment.sourceRevision === revision);
  const selected = current ?? parsed[0];
  if (!selected) return null;
  const state = current ? (current.assessment.status === 'unavailable' ? 'unavailable' : 'current') : 'stale';
  const policy = state === 'current' ? evaluateIntakePolicy(selected.assessment, r.stage, settings) : null;
  const overridden = activities
    .filter((a) => a.body.trimStart().toLowerCase().startsWith('intake-override/v1'))
    .some((a) => intakeOverrideRevision(a.body) === selected.assessment.sourceRevision);
  return { state, assessment: selected.assessment, policy, overridden };
}

export function intakeForTask(db: DB, r: TaskRow): IntakeSummary | null {
  return intakeSummaryFromActivities(r, intakeMarkerActivities(db, r.id), storedIntakeSettings(db));
}

export function intakeByTaskIds(db: DB, rows: TaskRow[]): Map<number, IntakeSummary | null> {
  const out = new Map<number, IntakeSummary | null>();
  if (rows.length === 0) return out;
  const settings = storedIntakeSettings(db);
  const histories = intakeMarkerActivitiesByTaskIds(db, rows.map((r) => r.id));
  for (const r of rows) out.set(r.id, intakeSummaryFromActivities(r, histories.get(r.id) ?? [], settings));
  return out;
}

/** The latest move into `queued` per task — where an intake pending hold starts — and its note. */
function latestQueuedByTaskIds(db: DB, ids: number[]): Map<number, { at: string; body: string }> {
  const out = new Map<number, { at: string; body: string }>();
  if (ids.length === 0) return out;
  const rows = db.prepare(
    `SELECT task_id, created_at AS at, body FROM activity
     WHERE type = 'status_change' AND to_status = 'queued' AND task_id IN (${ids.map(() => '?').join(',')})
     ORDER BY created_at, id`,
  ).all(...ids) as Array<{ task_id: number; at: string; body: string }>;
  for (const r of rows) out.set(r.task_id, { at: r.at, body: r.body }); // ascending: the last one wins
  return out;
}

/**
 * Intake pending hold — the pending branch of the intake spec's Stage 4 (§9), without the verdict
 * gate: queued implementation work in an intake-enabled workspace waits for an assessment of its
 * CURRENT revision (so a spec written by the description stage is assessed before anyone builds
 * it), for at most `maxHoldMinutes` after it was queued, then fails open. A current or unavailable
 * assessment releases it; the verdict itself stays advisory. A send-back or bounce re-queue keeps
 * an unchanged revision — still `current` — so it is never re-held.
 *
 * With `skipSpec` on, queued spec-stage work waits the same way, so intake decides whether to skip
 * the spec before a worker starts writing one. A task intake just moved to implementation (its
 * latest queue entry is the skip note) is not held again: that assessment was its intake review.
 */
export function intakeHoldFor(
  r: TaskRow, intake: IntakeSummary | null, settings: ReturnType<typeof normalizeIntakeSettings>, queued: { at: string; body: string } | undefined, now: string,
): { until: string } | null {
  if (r.status !== 'queued' || !holdsStage(r.stage, settings) || r.kind === 'pr-review' || r.archived_at !== null) return null;
  if (!intakeEnabledFor(settings, r.workspace_name) || queued === undefined) return null;
  if (intake !== null && intake.state !== 'stale') return null;
  if (r.stage === 'implementation' && queued.body.startsWith(SKIP_SPEC_NOTE_PREFIX)) return null;
  const until = Date.parse(queued.at) + settings.maxHoldMinutes * 60_000;
  return until > Date.parse(now) ? { until: new Date(until).toISOString() } : null;
}

function intakeHoldsByRows(db: DB, rows: TaskRow[], intakes: Map<number, IntakeSummary | null>, now: string): Map<number, { until: string } | null> {
  const out = new Map<number, { until: string } | null>();
  const settings = storedIntakeSettings(db);
  const candidates = rows.filter((r) => r.status === 'queued' && holdsStage(r.stage, settings) && intakeEnabledFor(settings, r.workspace_name));
  const queued = latestQueuedByTaskIds(db, candidates.map((r) => r.id));
  for (const r of candidates) out.set(r.id, intakeHoldFor(r, intakes.get(r.id) ?? null, settings, queued.get(r.id), now));
  return out;
}

/** Ids of the queued tasks an intake pending hold keeps unclaimable right now (claim-gate input). */
export function intakeHeldTaskIds(db: DB, now: string = nowIso(), workspaceId?: number): number[] {
  if (!intakeEnabledAnywhere(storedIntakeSettings(db))) return [];
  const rows = (workspaceId === undefined
    ? db.prepare(`${SELECT_TASK} WHERE task.status = 'queued' AND task.stage IN ('implementation', 'description') AND task.archived_at IS NULL`).all()
    : db.prepare(`${SELECT_TASK} WHERE task.status = 'queued' AND task.stage IN ('implementation', 'description') AND task.archived_at IS NULL AND task.workspace_id = ?`).all(workspaceId)
  ) as unknown as TaskRow[];
  const holds = intakeHoldsByRows(db, rows, intakeByTaskIds(db, rows), now);
  return rows.filter((r) => holds.get(r.id)).map((r) => r.id);
}

/** Stages a pending hold applies to: implementation always, the spec stage while skip-spec is on. */
const holdsStage = (stage: Stage, settings: ReturnType<typeof normalizeIntakeSettings>): boolean =>
  stage === 'implementation' || (stage === 'description' && settings.skipSpec);

const intakeEnabledAnywhere = (settings: ReturnType<typeof normalizeIntakeSettings>): boolean =>
  settings.mode !== 'off' && settings.workspaces.length > 0;

/**
 * The current failure event of a task: its latest `failure/v1` note (identity = activity id),
 * the parsed fields, the derived FailureSummary, and the note before it (the failure-triage
 * evidence rule's input). One shared selection feeds both Task.failure and Task.failureTriage.
 */
interface CurrentFailureEvent {
  note: FailureNoteRow; parsed: ParsedFailure; summary: FailureSummary;
  previous: FailureNoteRow | null; previousInEpisode: boolean;
}

/**
 * Current failure per task id, derived from the latest `failure/v1` comment and whether later
 * progress supersedes it (a successful submission clears the failure). A malformed latest marker
 * yields no failure — it is not skipped past to an older one. Mirrors aiReviewByTaskIds.
 */
function currentFailureEvents(db: DB, ids: number[]): Map<number, CurrentFailureEvent> {
  const out = new Map<number, CurrentFailureEvent>();
  if (ids.length === 0) return out;
  const pairs = latestFailureNotePairs(db, ids);
  if (pairs.size === 0) return out;
  const keys = [...pairs.keys()];
  // A failure is cleared by later *progress*: a new result (a worker crash superseded by a
  // successful submission), a new ai-review comment (a reviewer crash superseded by a
  // successful re-review), OR an operator restart/v1 marker (a skip-listed task restarted from
  // the board). Take the max id of any as the supersede marker.
  const results = latestResultIds(db, keys);
  const reviews = latestAiReviewComments(db, keys);
  const restarts = latestRestartMarkerIds(db, keys);
  for (const [taskId, { latest, previous }] of pairs) {
    const parsed = parseFailureComment(latest.body);
    if (!parsed) continue;
    const progressId = Math.max(results.get(taskId) ?? 0, reviews.get(taskId)?.id ?? 0, restarts.get(taskId) ?? 0);
    const summary = summarizeFailure(parsed, latest.createdAt, progressId > latest.id);
    if (!summary) continue;
    // the latest note is current ⇒ progressId < latest.id, so "no progress between previous and
    // latest" is exactly "previous is newer than the last progress"
    out.set(taskId, { note: latest, parsed, summary, previous, previousInEpisode: previous !== null && previous.id > progressId });
  }
  return out;
}

/** A parsed `failure-triage-feedback/v1` activity, or null when malformed (inert). */
export function feedbackFromActivity(a: Activity): FailureTriageFeedback | null {
  const record = parseFailureTriageFeedbackComment(a.body);
  if (!record) return null;
  return { ...record, activityId: a.id, actorUserId: a.actorUserId, actorName: a.actorName, at: a.createdAt };
}

/**
 * Failure triage per task (spec §7): only for tasks with a current failure that are neither
 * archived nor done. Two batched reads beyond the failure selection — the feedback markers — and
 * the rules run in-process.
 */
function failureTriageFromEvents(db: DB, rows: TaskRow[], events: Map<number, CurrentFailureEvent>): Map<number, FailureTriageSummary> {
  const out = new Map<number, FailureTriageSummary>();
  const eligible = rows.filter((r) => r.archived_at === null && r.status !== 'done' && events.has(r.id));
  if (eligible.length === 0) return out;
  const feedback = failureTriageFeedbackActivities(db, eligible.map((r) => r.id));
  for (const r of eligible) {
    const event = events.get(r.id)!;
    const classification = classifyFailureNote(event.note, event.parsed, event.previous, event.previousInEpisode);
    const human = (feedback.get(r.id) ?? [])
      .map(feedbackFromActivity)
      .find((f): f is FailureTriageFeedback => f !== null && f.sourceActivityId === event.note.id) ?? null;
    out.set(r.id, summarizeFailureTriage(event.note.id, classification, human));
  }
  return out;
}

function failureAndTriage(db: DB, rows: TaskRow[]): { failures: Map<number, FailureSummary>; triage: Map<number, FailureTriageSummary> } {
  const events = currentFailureEvents(db, rows.map((r) => r.id));
  const failures = new Map([...events].map(([taskId, event]) => [taskId, event.summary]));
  return { failures, triage: failureTriageFromEvents(db, rows, events) };
}

/**
 * Latest ai-review verdict per task id, derived from the latest `ai-review/v1` comment
 * and whether a result supersedes it (pending). Malformed marker comments are skipped —
 * they degrade to plain comments and carry no chip.
 */
function aiReviewByTaskIds(db: DB, ids: number[]): Map<number, AiReviewSummary> {
  const out = new Map<number, AiReviewSummary>();
  if (ids.length === 0) return out;
  const comments = latestAiReviewComments(db, ids);
  if (comments.size === 0) return out;
  const results = latestResultIds(db, [...comments.keys()]);
  for (const [taskId, { id: reviewId, body }] of comments) {
    const parsed = parseAiReviewComment(body);
    if (!parsed) continue;
    const resultId = results.get(taskId);
    const superseded = resultId !== undefined && resultId > reviewId;
    const task = reviewedTaskFor(db, taskId);
    const binding = parsed.revision ? reviewBinding(db, { ...task, id: taskId }, parsed.revision) : 'legacy';
    let summary = summarizeAiReview(parsed, superseded, binding);
    // An unbound green review cannot prove a tracked submission (it may predate a push the board
    // observes only later), so it reads pending until the reviewer posts a bound one. Unbound
    // findings keep their verdict — they still gate approval. A done task keeps its recorded
    // verdict, and tasks with no tracked submission keep the historical legacy reading.
    if (summary?.verdict === 'clean' && binding === 'legacy' && task.status !== 'done' && latestSubmissionFor(db, taskId, task.stage) !== undefined)
      summary = summarizeAiReview(parsed, true, binding);
    if (summary) out.set(taskId, summary);
  }
  return out;
}

function reviewedTaskFor(db: DB, taskId: number): DocContent & { stage: Stage; status: Status } {
  return db.prepare('SELECT spec, acceptance_criteria, plan, stage, status FROM task WHERE id = ?').get(taskId) as unknown as DocContent & { stage: Stage; status: Status };
}

/** The current stage's latest submission, with its freshness (migration #29); null when none. */
export function submissionFor(db: DB, r: TaskRow): SubmissionSummary | null {
  const s = latestSubmissionFor(db, r.id, r.stage);
  return s ? toSubmissionSummary(s, r) : null;
}

/** Latest ai-review verdict for one task (or null). Used by the approve path. */
export function aiReviewFor(db: DB, taskId: number): AiReviewSummary | null {
  return aiReviewByTaskIds(db, [taskId]).get(taskId) ?? null;
}

export function toDetail(db: DB, r: TaskRow): TaskDetail {
  const viz = visualizationMetaFor(db, r.id);
  const { failures, triage } = failureAndTriage(db, [r]);
  const aiReview = aiReviewByTaskIds(db, [r.id]).get(r.id) ?? null;
  return {
    ...toTask(r),
    aiReview,
    reviewBrief: buildReviewBrief(aiReview, r.acceptance_criteria, r.stage),
    failure: failures.get(r.id) ?? null,
    failureTriage: triage.get(r.id) ?? null,
    delivery: deliveryByTaskIds(db, [r.id]).get(r.id) ?? null,
    intake: intakeForTask(db, r),
    intakeHold: intakeHoldsByRows(db, [r], new Map([[r.id, intakeForTask(db, r)]]), nowIso()).get(r.id) ?? null,
    hasVisualization: viz !== null,
    visualizationGeneratedAt: viz?.generatedAt ?? null,
    visualizationRevision: viz?.revision ?? null,
    submission: submissionFor(db, r),
    repoPath: r.workspace_repo_path,
    branch: r.branch,
    plan: r.plan,
    originalSpec: r.original_spec,
    originalAcceptanceCriteria: r.original_acceptance_criteria,
    policy: r.workspace_policy,
    verifyCommand: r.workspace_verify_command,
    activity: recentActivity(db, r.id, RECENT_ACTIVITY_LIMIT),
    criteriaClaims: criteriaClaimsFor(db, r.id),
    links: linksFor(db, r.id),
    attachments: attachmentsMeta(db, r.id),
    dependencies: dependenciesFor(db, r.id),
    dependents: dependentsFor(db, r.id),
    metrics: {
      ...deriveTaskMetrics(activitySteps(db, r.id), nowIso()),
      ...tokenAggregateFor(db, r.id),
      tokenBreakdown: tokenBreakdownFor(db, r.id),
    },
  };
}

export function findRowByKey(db: DB, key: string): TaskRow | undefined {
  return db.prepare(`${SELECT_TASK} WHERE task.key = ?`).get(key) as TaskRow | undefined;
}
export function findByKey(db: DB, key: string): Task | null {
  const r = findRowByKey(db, key);
  return r ? toTask(r) : null;
}
export function setStatus(db: DB, id: number, status: Status, ts: string): void {
  // a re-queued task must not advertise a stale claimant — every path into 'queued'
  // (release, request-changes, blocked → queued) flows through here
  if (status === 'queued') {
    db.prepare('UPDATE task SET status = ?, claimed_by = NULL, claimed_at = NULL, updated_at = ? WHERE id = ?').run(status, ts, id);
  } else {
    db.prepare('UPDATE task SET status = ?, updated_at = ? WHERE id = ?').run(status, ts, id);
  }
}
export function setStage(db: DB, id: number, stage: Stage, ts: string): void {
  db.prepare('UPDATE task SET stage = ?, updated_at = ? WHERE id = ?').run(stage, ts, id);
}
export function setPlan(db: DB, id: number, plan: string, ts: string): void {
  db.prepare('UPDATE task SET plan = ?, updated_at = ? WHERE id = ?').run(plan, ts, id);
}
export function setResultSummary(db: DB, id: number, summary: string, ts: string): void {
  db.prepare('UPDATE task SET result_summary = ?, updated_at = ? WHERE id = ?').run(summary, ts, id);
}
export function deleteRowById(db: DB, id: number): void {
  // activity and link rows go with it (ON DELETE CASCADE; foreign_keys=ON per connection)
  db.prepare('DELETE FROM task WHERE id = ?').run(id);
}
export function touch(db: DB, id: number, ts: string): void {
  db.prepare('UPDATE task SET updated_at = ? WHERE id = ?').run(ts, id);
}
export function applyEdit(db: DB, id: number, fields: UpdateTaskInput, ts: string, workspaceId?: number): void {
  const sets: string[] = [];
  // Cast to (string | number)[] — SQLInputValue includes both; spread is valid at runtime.
  const vals: (string | number)[] = [];
  if (fields.title !== undefined) { sets.push('title = ?'); vals.push(fields.title); }
  if (fields.spec !== undefined) { sets.push('spec = ?'); vals.push(fields.spec); }
  if (fields.acceptanceCriteria !== undefined) { sets.push('acceptance_criteria = ?'); vals.push(fields.acceptanceCriteria); }
  if (workspaceId !== undefined) { sets.push('workspace_id = ?'); vals.push(workspaceId); }
  sets.push('updated_at = ?'); vals.push(ts);
  vals.push(id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (db.prepare(`UPDATE task SET ${sets.join(', ')} WHERE id = ?`).run as (...a: any[]) => unknown)(...vals);
}
/**
 * One-time snapshot of the human-written spec/acceptance criteria, taken just before the
 * description stage rewrites them. The `original_spec IS NULL` guard makes it idempotent:
 * the first description-stage submit captures the original; later re-submits never clobber it.
 */
export function snapshotOriginal(db: DB, id: number, spec: string, acceptanceCriteria: string, ts: string): void {
  db.prepare(
    `UPDATE task SET original_spec = ?, original_acceptance_criteria = ?, updated_at = ?
     WHERE id = ? AND original_spec IS NULL`,
  ).run(spec, acceptanceCriteria, ts, id);
}
export function setArchived(db: DB, id: number, archivedAt: string | null, ts: string): void {
  // bumping updated_at moves getVersion(), so SSE-driven clients refetch on (un)archive
  db.prepare('UPDATE task SET archived_at = ?, updated_at = ? WHERE id = ?').run(archivedAt, ts, id);
}
export function listRows(db: DB, opts: { status?: Status | undefined; workspaceId?: number | undefined; archived?: boolean | undefined } = {}): Task[] {
  // archived rows are opt-in: every default listing (board, queue, MCP list_tasks) hides them
  const where: string[] = [opts.archived ? 'task.archived_at IS NOT NULL' : 'task.archived_at IS NULL'];
  const vals: (string | number)[] = [];
  if (opts.status) { where.push('task.status = ?'); vals.push(opts.status); }
  if (opts.workspaceId !== undefined) { where.push('task.workspace_id = ?'); vals.push(opts.workspaceId); }
  const sql = `${SELECT_TASK}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY task.seq ASC`;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rows = (db.prepare(sql).all as (...a: any[]) => unknown)(...vals) as TaskRow[];
  const ids = rows.map((r) => r.id);
  const reviews = aiReviewByTaskIds(db, ids);
  const { failures, triage } = failureAndTriage(db, rows);
  const deliveries = deliveryByTaskIds(db, ids);
  const intakes = intakeByTaskIds(db, rows);
  const holds = intakeHoldsByRows(db, rows, intakes, nowIso());
  // the brief (every issue with full evidence) is built for the cards that show it: tasks in review
  return rows.map((r) => ({ ...toTask(r), aiReview: reviews.get(r.id) ?? null,
    reviewBrief: r.status === 'in_review' ? buildReviewBrief(reviews.get(r.id) ?? null, r.acceptance_criteria, r.stage) : null, failure: failures.get(r.id) ?? null, failureTriage: triage.get(r.id) ?? null, delivery: deliveries.get(r.id) ?? null, intake: intakes.get(r.id) ?? null, intakeHold: holds.get(r.id) ?? null }));
}
/** The in_progress task a worker label already holds (oldest first), if any — the claim
 *  reconciliation read: a retried claim (lost HTTP response) returns the held task instead of
 *  claiming a second one. */
export function heldClaimRow(db: DB, claimedBy: string, workspaceId?: number): TaskRow | undefined {
  const held = `task.status='in_progress' AND task.claimed_by = ?`;
  return (workspaceId === undefined
    ? db.prepare(`${SELECT_TASK} WHERE ${held} ORDER BY task.seq ASC LIMIT 1`).get(claimedBy)
    : db.prepare(`${SELECT_TASK} WHERE ${held} AND task.workspace_id = ? ORDER BY task.seq ASC LIMIT 1`).get(claimedBy, workspaceId)
  ) as TaskRow | undefined;
}

// Claim eligibility, shared by queue selection, a claim through a reservation, and the reservation
// itself. Archived rows are always done, but the guard makes "never claim an archived task" hold
// unconditionally rather than by inference. The kind guard is defense in depth: a pr-review task
// is reviewed, never implemented (updateStatus blocks it from ever reaching 'queued'), so a worker
// must never claim one even if one is stranded there.
const CLAIM_ELIGIBLE = `task.status='queued'
    AND task.kind != 'pr-review'
    AND task.archived_at IS NULL
    AND NOT EXISTS (
      SELECT 1
      FROM task_dependency dependency
      JOIN task prerequisite ON prerequisite.id = dependency.depends_on_task_id
      WHERE dependency.task_id = task.id AND prerequisite.status != 'done'
    )
    -- A delivery repair budget is task-scoped and must also guard interactive claims. Once it is
    -- exhausted, only an explicit operator restart can make this queued task eligible again.
    AND NOT EXISTS (
      SELECT 1 FROM retry_budget budget
      WHERE budget.task_id = task.id AND budget.operation = 'delivery'
        AND budget.generation = (SELECT MAX(latest_budget.generation) FROM retry_budget latest_budget WHERE latest_budget.task_id = task.id AND latest_budget.operation = 'delivery')
        AND budget.attempts_used >= budget.max_attempts
    )`;

/** Who is claiming: queue selection skips tasks another claimant's live reservation owns. */
export interface Claimant { label: string | null; now: string; }

export function oldestQueuedRow(db: DB, workspaceId?: number, taskKey?: string, stage?: Stage, claimant?: Claimant, excludeIds: number[] = []): TaskRow | undefined {
  const filters: string[] = [CLAIM_ELIGIBLE];
  const params: (string | number | null)[] = [];
  // intake pending holds (intakeHeldTaskIds): computed in JS — the hold derives from activity JSON
  if (excludeIds.length > 0) { filters.push(`task.id NOT IN (${excludeIds.map(() => '?').join(',')})`); params.push(...excludeIds); }
  if (workspaceId !== undefined) { filters.push('task.workspace_id = ?'); params.push(workspaceId); }
  if (taskKey !== undefined) { filters.push('task.key = ?'); params.push(taskKey); }
  if (stage !== undefined) { filters.push('task.stage = ?'); params.push(stage); }
  if (claimant !== undefined) { filters.push(`NOT ${RESERVED_BY_OTHER_SQL}`); params.push(...reservedByOtherParams(claimant.label, claimant.now)); }
  return db.prepare(`${SELECT_TASK} WHERE ${filters.join(' AND ')} ORDER BY task.seq ASC LIMIT 1`).get(...params) as TaskRow | undefined;
}

/** The task, only while it passes the same claim-eligibility rules as queue selection. */
export function claimableQueuedRow(db: DB, id: number, workspaceId?: number): TaskRow | undefined {
  return (workspaceId === undefined
    ? db.prepare(`${SELECT_TASK} WHERE ${CLAIM_ELIGIBLE} AND task.id = ?`).get(id)
    : db.prepare(`${SELECT_TASK} WHERE ${CLAIM_ELIGIBLE} AND task.id = ? AND task.workspace_id = ?`).get(id, workspaceId)
  ) as TaskRow | undefined;
}

/** True when another claimant's live reservation (inside its lease) owns the task. */
export function reservedByOther(db: DB, id: number, claimant: Claimant): boolean {
  return db.prepare(`SELECT 1 AS hit FROM task WHERE task.id = ? AND ${RESERVED_BY_OTHER_SQL}`)
    .get(id, ...reservedByOtherParams(claimant.label, claimant.now)) !== undefined;
}
