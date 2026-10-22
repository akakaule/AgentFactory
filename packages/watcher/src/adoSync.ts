import { adoIdFromTitle, buildInboundWiql, htmlToText, type AdoSyncSettings, type Status, type Task } from '@agentfactory/core';
import type { WatcherCore } from './types.js';
import type { AdoProject, AdoWorkItem, AzdoWorkItemsApi, JsonPatchOp } from './providers/azdoWorkItems.js';
import { ProviderHttpError } from './providers/types.js';

/**
 * One workspace's Azure DevOps work-item sync — the ado-bridge backlog loop (Run-AdoBridgeLoop),
 * run by the watcher each tick for a workspace whose `adoSync` is enabled and whose origin is on
 * Azure DevOps. No state of its own: every step keys on the `AB#<id>:` title prefix and the item's
 * tags/state, so a failure part-way through is picked up again on the next tick.
 *
 *  - inbound: claim matching items (rev-tested), import each as an `AB#<id>: <title>` task
 *    (core importTask: idempotent, queued), then tag the item `<markerTag>` + `AF:<key>`;
 *  - outbound: implementation in review → `reviewState`; done → `closeState` with the result
 *    summary — only for items still in a state this sync set, so hand-moved items are left alone.
 *
 * Per-item failures are logged and retried next tick; a rate limit or an auth failure is thrown,
 * so the watcher pauses / backs off the whole workspace.
 */
export interface AdoSyncContext {
  core: Pick<WatcherCore, 'listTasks' | 'importTask'>;
  api: AzdoWorkItemsApi;
  workspace: string;
  project: AdoProject;
  settings: AdoSyncSettings;
  /** The identity claimed items are assigned to (settings.assignTo, else the PAT owner). */
  assignee: string;
  log: (msg: string) => void;
}

const AUTH_STATUSES = new Set([203, 401, 403]);
/** Errors that will fail every item the same way — stop the pass and let the watcher back off. */
const isFatal = (err: unknown): boolean =>
  err instanceof ProviderHttpError && (err.pauseUntilMs !== null || AUTH_STATUSES.has(err.status));
const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const INBOUND_FIELDS = ['System.Title', 'System.Description', 'System.State', 'System.Tags', 'System.AssignedTo', 'Microsoft.VSTS.Common.AcceptanceCriteria'];

export function workItemUrl(p: AdoProject, id: number): string {
  return `https://dev.azure.com/${encodeURIComponent(p.organization)}/${encodeURIComponent(p.project)}/_workitems/edit/${id}`;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
/** AssignedTo comes back as an identity object (`uniqueName` = user@domain); tolerate a plain string. */
const uniqueName = (v: unknown): string =>
  (typeof v === 'string' ? v : str((v as { uniqueName?: unknown } | null)?.uniqueName)).toLowerCase();
const tagsOf = (wi: AdoWorkItem): string[] => str(wi.fields['System.Tags']).split(';').map((t) => t.trim()).filter(Boolean);

const htmlEscape = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export async function syncInbound(ctx: AdoSyncContext): Promise<void> {
  const { api, project, settings: s, workspace, assignee, log } = ctx;
  const ids = await api.wiql(project, buildInboundWiql(s, assignee));
  if (ids.length === 0) return;
  const items = await api.batch(project, ids, INBOUND_FIELDS);

  // tasks already on the board for these items (any created by the PowerShell bridge included);
  // they don't count against the per-tick cap
  const known = new Set<number>();
  for (const t of await ctx.core.listTasks({ workspace })) {
    const id = adoIdFromTitle(t.title);
    if (id !== null) known.add(id);
  }

  let imported = 0;
  let deferred = 0;
  for (const wi of items) {
    const id = Number(wi.id);
    if (!known.has(id) && imported >= s.maxImportsPerTick) { deferred++; continue; }
    try {
      let fresh = wi;
      const state = str(wi.fields['System.State']);
      if (!(uniqueName(wi.fields['System.AssignedTo']) === assignee.toLowerCase() && state === s.claimState)) {
        // race-safe claim: the rev test makes a concurrent human edit win cleanly
        try {
          fresh = await api.patch(project, id, [
            { op: 'test', path: '/rev', value: wi.rev },
            { op: 'add', path: '/fields/System.AssignedTo', value: assignee },
            { op: 'add', path: '/fields/System.State', value: s.claimState },
          ]);
        } catch (err) {
          if (isFatal(err)) throw err;
          log(`AB#${id}: claim lost or rejected (${message(err)}) — skipping`);
          continue;
        }
      }

      const title = str(wi.fields['System.Title']).trim() || `Work item ${id}`;
      const url = workItemUrl(project, id);
      const description = htmlToText(str(wi.fields['System.Description']), s.maxDescriptionChars) || '(no description provided)';
      const ac = htmlToText(str(wi.fields['Microsoft.VSTS.Common.AcceptanceCriteria']), s.maxDescriptionChars)
        || (s.stage === 'implementation' ? 'Implement the work item as described in the spec.' : '');
      const { task, created } = await ctx.core.importTask({
        workspace,
        title: `AB#${id}: ${title}`,
        spec: `ADO Work Item: AB#${id} - ${url}\n\n${description}`,
        ...(ac ? { acceptanceCriteria: ac } : {}),
        stage: s.stage,
        links: [{ kind: 'url', label: `AB#${id}`, url }],
        dedupPrefix: `AB#${id}:`,
        note: `Imported from Azure DevOps work item AB#${id} (${url}).`,
        queue: s.autoQueue,
      });
      if (created) { imported++; known.add(id); log(`AB#${id}: imported as ${task.key} (${task.status})`); }

      // the commit marker, last: until it lands the recovery clause re-selects the item
      const tags = tagsOf(fresh);
      for (const tag of [s.markerTag, `AF:${task.key}`]) if (!tags.includes(tag)) tags.push(tag);
      await api.patch(project, id, [
        { op: 'test', path: '/rev', value: fresh.rev },
        { op: 'add', path: '/fields/System.Tags', value: tags.join('; ') },
        { op: 'add', path: '/fields/System.History', value: `Imported to AgentFactory as <b>${task.key}</b> (workspace: ${htmlEscape(workspace)}).` },
      ]);
    } catch (err) {
      if (isFatal(err)) throw err;
      log(`AB#${id}: import failed (${message(err)}) — will retry next poll`);
    }
  }
  if (deferred > 0) log(`${deferred} more work item(s) deferred to the next poll (maxImportsPerTick ${s.maxImportsPerTick})`);
}

interface OutboundRule { status: Status; target: string; allowedFrom: string[]; implementationOnly: boolean; comment: (t: Task) => string }

export async function syncOutbound(ctx: AdoSyncContext): Promise<void> {
  const { api, project, settings: s, workspace, log } = ctx;
  const rules: OutboundRule[] = [{
    status: 'done', target: s.closeState, implementationOnly: false,
    allowedFrom: [s.claimState, s.reviewState].filter(Boolean),
    comment: (t) => {
      const summary = htmlEscape(t.resultSummary ?? '(no result summary)').replace(/\r?\n/g, '<br/>');
      const pr = t.delivery?.prUrl ? `<br/><br/>Pull request: <a href="${htmlEscape(t.delivery.prUrl)}">${htmlEscape(t.delivery.prUrl)}</a>` : '';
      return `AgentFactory task <b>${t.key}</b> completed.<br/><br/>${summary}${pr}`;
    },
  }];
  // a task is in_review once per stage; only the implementation review means "code submitted"
  if (s.reviewState) {
    rules.push({
      status: 'in_review', target: s.reviewState, implementationOnly: true, allowedFrom: [s.claimState],
      comment: (t) => `AgentFactory task <b>${t.key}</b> submitted for review.`,
    });
  }

  for (const rule of rules) {
    const byId = new Map<number, Task>();
    for (const t of await ctx.core.listTasks({ workspace, status: rule.status })) {
      if (rule.implementationOnly && t.stage !== 'implementation') continue;
      const id = adoIdFromTitle(t.title);
      if (id !== null) byId.set(id, t);
    }
    if (byId.size === 0) continue;
    const items = await api.batch(project, [...byId.keys()], ['System.State']);
    for (const wi of items) {
      const id = Number(wi.id);
      const task = byId.get(id)!;
      const state = str(wi.fields['System.State']);
      if (state === rule.target) continue; // already written — the idempotency guard
      if (!rule.allowedFrom.includes(state)) continue; // moved by hand — not ours to touch
      const ops: JsonPatchOp[] = [
        { op: 'add', path: '/fields/System.State', value: rule.target },
        { op: 'add', path: '/fields/System.History', value: rule.comment(task) },
      ];
      try {
        await api.patch(project, id, ops); // no rev test: last-writer-wins on the write-back
        log(`AB#${id}: → '${rule.target}' (${task.key} is ${rule.status})`);
      } catch (err) {
        if (isFatal(err)) throw err;
        log(`AB#${id}: write-back failed (${message(err)}) — will retry next poll`);
      }
    }
  }
}
