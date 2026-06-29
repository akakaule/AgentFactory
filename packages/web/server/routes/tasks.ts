import { Hono } from 'hono';
import { zValidator } from '@hono/zod-validator';
import type { Core } from '../types.js';
import { NotFoundError, ValidationError, type UpdateTaskInput, type AddTaskMetricsInput } from '@agentfactory/core';
import { createBody, updateBody, commentBody, statusBody, feedbackBody, listQuery, metricsBody, attachmentBody, archiveAllBody } from '../schemas.js';
import { branchDiff } from '../git.js';
import { refFromLabel, fetchRemoteRef } from '@agentfactory/core';
import { actorUserIdOf } from '../auth.js';

// Generous ceiling for an attached visualization (self-contained HTML compresses well; a real one
// is tens of KB). Bounds a runaway/abusive upload without rejecting a legitimately rich page.
const MAX_VISUALIZATION_BYTES = 4 * 1024 * 1024;

export function taskRoutes(core: Core) {
  const r = new Hono();

  r.get('/', zValidator('query', listQuery), (c) => {
    const { status, workspace, archived } = c.req.valid('query');
    return c.json(core.listTasks({ status, workspace, archived: archived === 'true' ? true : undefined }));
  });

  // registered before the /:key routes so the static segment is never read as a task key
  r.post('/archive-done', zValidator('json', archiveAllBody), (c) =>
    c.json(core.archiveDoneTasks({ workspace: c.req.valid('json').workspace })));

  r.get('/:key', (c) => c.json(core.getTask(c.req.param('key'))));

  r.get('/:key/diff', async (c) => {
    const task = core.getTask(c.req.param('key'));
    const branchLink = task.links.filter((l) => l.kind === 'branch').at(-1);
    if (!branchLink) throw new NotFoundError(`no branch link recorded for ${task.key}`);
    // Diff against the bare ref recovered from a possibly-decorated label; the raw label is
    // the fallback so a hostile/unparseable one still trips branchDiff's SAFE_REF guard (400).
    const ref = refFromLabel(branchLink.label) ?? branchLink.label;
    // A pr-review task's branch link is a teammate's PR head — not in the local store. Fetch it into
    // origin/<head> and diff that; resolveBaseRef yields origin/<default>, so the diff is
    // origin/<base>...origin/<head>. (Makes the Changes view + /visualize-task work for PR reviews.)
    let diffRef = ref;
    if (task.kind === 'pr-review') {
      await fetchRemoteRef(task.repoPath, ref);
      diffRef = `origin/${ref}`;
    }
    const { baseRef, diff, commits } = await branchDiff(task.repoPath, diffRef);
    return c.json({ branch: branchLink.label, baseRef, diff, commits });
  });

  // getTranscript never throws — an unknown task / no capture returns { state: 'none', … }.
  r.get('/:key/transcript', (c) => c.json(core.getTranscript(c.req.param('key'))));

  // Change visualization — a rendered view of the diff, so HTTP-only like /diff (the MCP server
  // has no visualization tool). GET serves the stored self-contained HTML; the client only calls
  // it when TaskDetail.hasVisualization is set, so a 404 here is just defensive.
  r.get('/:key/visualization', (c) => {
    const html = core.getVisualizationHtml(c.req.param('key'));
    if (html == null) throw new NotFoundError(`no visualization for ${c.req.param('key')}`);
    return c.html(html);
  });

  // POST attaches/replaces it. The body is the raw HTML (text/html, not JSON) — the producer uploads
  // with `curl --data-binary @file`. Cap the size so a runaway upload can't bloat the DB.
  r.post('/:key/visualization', async (c) => {
    const html = await c.req.text();
    if (!html.trim()) throw new ValidationError('visualization HTML body is empty');
    if (html.length > MAX_VISUALIZATION_BYTES) {
      throw new ValidationError(`visualization HTML exceeds ${MAX_VISUALIZATION_BYTES} bytes`);
    }
    const meta = core.attachVisualization(c.req.param('key'), { html });
    return c.json({ ok: true, bytes: meta.bytes }, 201);
  });

  r.post('/', zValidator('json', createBody), (c) => c.json(core.createTask(c.req.valid('json')), 201));

  r.patch('/:key', zValidator('json', updateBody), (c) => {
    const b = c.req.valid('json');
    const fields: UpdateTaskInput = {};            // build explicitly to satisfy exactOptionalPropertyTypes
    if (b.title !== undefined) fields.title = b.title;
    if (b.spec !== undefined) fields.spec = b.spec;
    if (b.acceptanceCriteria !== undefined) fields.acceptanceCriteria = b.acceptanceCriteria;
    return c.json(core.updateTask(c.req.param('key'), fields));
  });

  r.delete('/:key', (c) => {
    core.deleteTask(c.req.param('key'));
    return c.body(null, 204);
  });

  r.post('/:key/comment', zValidator('json', commentBody), (c) =>
    c.json(core.addComment(c.req.param('key'), { actor: 'human', body: c.req.valid('json').body, actorUserId: actorUserIdOf(c) }), 201));

  r.post('/:key/status', zValidator('json', statusBody), (c) =>
    c.json(core.updateStatus(c.req.param('key'), c.req.valid('json').status, 'human', actorUserIdOf(c), c.req.valid('json').note)));

  r.post('/:key/metrics', zValidator('json', metricsBody), (c) => {
    const b = c.req.valid('json');
    const input: AddTaskMetricsInput = {};         // explicit build for exactOptionalPropertyTypes
    if (b.model !== undefined) input.model = b.model;
    if (b.tokensIn !== undefined) input.tokensIn = b.tokensIn;
    if (b.tokensOut !== undefined) input.tokensOut = b.tokensOut;
    if (b.costUsd !== undefined) input.costUsd = b.costUsd;
    if (b.reportedBy !== undefined) input.reportedBy = b.reportedBy;
    return c.json(core.addTaskMetrics(c.req.param('key'), input), 201);
  });

  r.post('/:key/attachments', zValidator('json', attachmentBody), (c) =>
    c.json(core.addAttachment(c.req.param('key'), c.req.valid('json')), 201));

  r.post('/:key/archive', (c) => c.json(core.archiveTask(c.req.param('key'))));

  r.post('/:key/unarchive', (c) => c.json(core.unarchiveTask(c.req.param('key'))));

  r.post('/:key/approve', (c) => c.json(core.reviewApprove(c.req.param('key'), actorUserIdOf(c))));

  r.post('/:key/request-changes', zValidator('json', feedbackBody), (c) =>
    c.json(core.reviewRequestChanges(c.req.param('key'), { feedback: c.req.valid('json').feedback, actorUserId: actorUserIdOf(c) })));

  return r;
}
