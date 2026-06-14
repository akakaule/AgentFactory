import type { DB } from '../db.js';
import type { AgentSessionView, AgentMilestone, Stage, Status } from '../types.js';

// Rolling milestone feed cap — keeps the live row small and bounded.
const RECENT_CAP = 10;

/**
 * Repo primitives for the `agent_session` live table. These run INSIDE a caller's
 * transaction (claimNextTask/submitResult) or one opened by ops/agentSession.ts — they
 * never open their own. None touch task.updated_at, so getVersion() is unaffected.
 */

/** Start a live session for a task (on claim). Defensively ends any dangling live row first. */
export function startSession(
  db: DB,
  s: { taskId: number; label: string | null; workspace: string; stage: Stage; now: string },
): void {
  db.prepare('UPDATE agent_session SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL').run(s.now, s.taskId);
  db.prepare(
    'INSERT INTO agent_session(task_id, label, workspace, stage, started_at, heartbeat_at) VALUES (?,?,?,?,?,?)',
  ).run(s.taskId, s.label, s.workspace, s.stage, s.now, s.now);
}

/** End the live session for a task (submit / exit). Idempotent — no-op if none is live. */
export function endSession(db: DB, taskId: number, now: string): void {
  db.prepare('UPDATE agent_session SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL').run(now, taskId);
}

/** Liveness heartbeat (dispatcher tick) — bumps last-seen without changing the milestone. */
export function touchSession(db: DB, taskId: number, now: string): void {
  db.prepare('UPDATE agent_session SET heartbeat_at = ? WHERE task_id = ? AND ended_at IS NULL').run(now, taskId);
}

/** Record a milestone: set the current phase, append to the rolling feed, bump heartbeat,
 *  and merge any reported token counts. No-op if the task has no live session. */
export function updateProgress(
  db: DB,
  p: { taskId: number; message: string; tokensIn: number | null; tokensOut: number | null; now: string },
): void {
  const row = db.prepare('SELECT recent FROM agent_session WHERE task_id = ? AND ended_at IS NULL')
    .get(p.taskId) as { recent: string | null } | undefined;
  if (!row) return;
  const recent: AgentMilestone[] = row.recent ? (JSON.parse(row.recent) as AgentMilestone[]) : [];
  recent.push({ msg: p.message, at: p.now });
  db.prepare(
    `UPDATE agent_session
       SET phase = ?, phase_at = ?, recent = ?, heartbeat_at = ?,
           tokens_in = COALESCE(?, tokens_in), tokens_out = COALESCE(?, tokens_out)
     WHERE task_id = ? AND ended_at IS NULL`,
  ).run(p.message, p.now, JSON.stringify(recent.slice(-RECENT_CAP)), p.now, p.tokensIn, p.tokensOut, p.taskId);
}

interface LiveRow {
  label: string | null; workspace: string; stage: Stage; phase: string | null; phase_at: string | null;
  recent: string | null; tokens_in: number | null; tokens_out: number | null;
  started_at: string; heartbeat_at: string; key: string; title: string; status: Status;
}

/** Every currently-running agent (ended_at IS NULL), joined to its task, oldest first. */
export function listLiveSessions(db: DB): AgentSessionView[] {
  const rows = db.prepare(
    `SELECT s.label, s.workspace, s.stage, s.phase, s.phase_at, s.recent, s.tokens_in, s.tokens_out,
            s.started_at, s.heartbeat_at, t.key, t.title, t.status
       FROM agent_session s JOIN task t ON t.id = s.task_id
      WHERE s.ended_at IS NULL
      ORDER BY s.started_at ASC`,
  ).all() as unknown as LiveRow[];
  return rows.map((r) => ({
    key: r.key, title: r.title, status: r.status, workspace: r.workspace, stage: r.stage,
    label: r.label, phase: r.phase, phaseAt: r.phase_at,
    recent: r.recent ? (JSON.parse(r.recent) as AgentMilestone[]) : [],
    tokensIn: r.tokens_in, tokensOut: r.tokens_out,
    startedAt: r.started_at, heartbeatAt: r.heartbeat_at,
  }));
}
