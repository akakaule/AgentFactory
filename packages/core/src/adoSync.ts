import { z } from 'zod';

/**
 * Azure DevOps work-item import, configured per workspace (migration #27 `workspace.ado_sync`).
 * Ported from ado-bridge's Run-AdoBridgeLoop: the watcher claims matching work items, imports each
 * as an `AB#<id>: <title>` task, and writes the board state back to the item. The organization and
 * project are never stored — they come from the workspace's Azure DevOps origin (remote.ts).
 * Everything here is pure so the watcher (sync) and the board server (WIQL preview) share it.
 */

const text = z.string().trim();
const required = (what: string) => z.string().trim().min(1, `${what} is required`);
const nameList = z.array(z.string().trim().min(1)).min(1);
// JSON forces `\\` for a backslash; accept `/` as the friendlier separator (as ado-bridge did).
const areaPath = text.transform((s) => s.replace(/\//g, '\\'));

export const adoSyncSettingsSchema = z
  .object({
    enabled: z.boolean().default(false),
    /** Work item types to import (`User Story`; Scrum: `Product Backlog Item`). */
    workItemTypes: nameList.default(['User Story']),
    /** States that count as "new, not yet picked up". */
    states: nameList.default(['New']),
    areaPath: areaPath.default(''),
    iterationPath: areaPath.default(''),
    /** Opt-in gate: only items carrying this tag are imported (and it overrules an existing assignee). */
    requiredTag: text.default(''),
    /** WIQL ORDER BY; blank = backlog order (StackRank, then ChangedDate). */
    orderBy: text.default(''),
    /** Identity claimed items are assigned to; blank = the PAT's owner. */
    assignTo: text.default(''),
    claimState: required('claimState').default('Active'),
    /** Reflected when the implementation is submitted for review; blank turns the reflection off. */
    reviewState: text.default('Resolved'),
    /** Set once the task is done (in the default flow: its PR merged). */
    closeState: required('closeState').default('Closed'),
    /** Tag that marks an item as imported (the crash-recovery clause keys on it). */
    markerTag: required('markerTag').default('agentfactory'),
    /** Pipeline stage imported tasks enter at. */
    stage: z.enum(['description', 'implementation']).default('description'),
    /** Queue imported tasks for the dispatcher straight away (else they wait in backlog). */
    autoQueue: z.boolean().default(true),
    maxDescriptionChars: z.number().int().min(200).max(100_000).default(8000),
    maxImportsPerTick: z.number().int().min(1).max(100).default(10),
  })
  .strict()
  // WIQL CONTAINS is substring-based and the recovery clause excludes markerTag, so the two tags
  // must differ or a crashed import could never be recovered.
  .refine((s) => !s.requiredTag || s.requiredTag !== s.markerTag, { message: 'requiredTag must differ from markerTag', path: ['requiredTag'] });

export type AdoSyncSettings = z.output<typeof adoSyncSettingsSchema>;
export type AdoSyncSettingsInput = z.input<typeof adoSyncSettingsSchema>;

export function defaultAdoSyncSettings(): AdoSyncSettings {
  return adoSyncSettingsSchema.parse({});
}

/** Read the stored column; null, corrupt or no-longer-valid JSON reads as null (= import off). */
export function parseAdoSyncSettings(raw: string | null): AdoSyncSettings | null {
  if (!raw) return null;
  try {
    const r = adoSyncSettingsSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

const wiqlString = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const wiqlList = (xs: readonly string[]): string => xs.map(wiqlString).join(', ');

/**
 * The inbound claim query (port of ado-bridge `Build-InboundWiql`): new items — unassigned, or
 * tag-gated when `requiredTag` is set — plus a recovery clause for items a previous pass claimed
 * but never finished marking. `assignee` is the claiming identity, or the `@Me` macro.
 */
export function buildInboundWiql(s: AdoSyncSettings, assignee: string): string {
  const conds = ['[System.TeamProject] = @project'];
  conds.push(s.workItemTypes.length === 1
    ? `[System.WorkItemType] = ${wiqlString(s.workItemTypes[0]!)}`
    : `[System.WorkItemType] IN (${wiqlList(s.workItemTypes)})`);
  if (s.areaPath) conds.push(`[System.AreaPath] UNDER ${wiqlString(s.areaPath)}`);
  if (s.iterationPath) conds.push(`[System.IterationPath] UNDER ${wiqlString(s.iterationPath)}`);
  if (s.requiredTag) conds.push(`[System.Tags] CONTAINS ${wiqlString(s.requiredTag)}`);

  const states = `[System.State] IN (${wiqlList(s.states)})`;
  // with an opt-in tag the tag is authoritative: import even already-assigned items
  const open = s.requiredTag ? `(${states})` : `([System.AssignedTo] = '' AND ${states})`;
  const who = assignee === '@Me' ? '@Me' : wiqlString(assignee);
  const recovery = `([System.AssignedTo] = ${who} AND [System.State] = ${wiqlString(s.claimState)}`
    + ` AND [System.Tags] NOT CONTAINS ${wiqlString(s.markerTag)})`;
  const orderBy = s.orderBy || '[Microsoft.VSTS.Common.StackRank] ASC, [System.ChangedDate] ASC';
  return `SELECT [System.Id] FROM WorkItems WHERE ${conds.join(' AND ')} AND (${open} OR ${recovery}) ORDER BY ${orderBy}`;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Work-item description HTML → plain text (port of ado-bridge `Convert-HtmlToText`). */
export function htmlToText(html: string | null | undefined, maxChars: number): string {
  if (!html || !html.trim()) return '';
  let t = html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<li(\s[^>]*)?>/gi, '- ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) ? String.fromCodePoint(code) : m;
      }
      return ENTITIES[e.toLowerCase()] ?? m;
    })
    .replace(/(\r?\n[ \t]*){3,}/g, '\n\n')
    .trim();
  if (maxChars > 0 && t.length > maxChars) t = `${t.slice(0, maxChars)}\n... (truncated)`;
  return t;
}

/** The ADO id an imported task's title carries (`AB#123: …`) — the import's dedup key. */
export function adoIdFromTitle(title: string): number | null {
  const m = /^AB#(\d+):/.exec(title);
  return m ? Number(m[1]) : null;
}

/** Marker on the comment `importTask` writes, so the activity log shows where a task came from. */
export const ADO_IMPORT_MARKER = 'ado-import/v1';
