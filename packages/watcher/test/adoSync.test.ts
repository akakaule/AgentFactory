import { describe, it, expect } from 'vitest';
import type { Core } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { ADO_ORIGIN, GH_ORIGIN, makeConfig, makeCore, makeDeps } from './helpers.js';

/**
 * The ado-bridge backlog loop, ported into the watcher: a workspace whose origin is Azure DevOps
 * and whose `adoSync` settings are enabled gets its matching work items claimed and imported as
 * `AB#<id>:` tasks, and its board state written back to the items.
 */

const ORG = 'https://dev.azure.com/acme';
const PROJ = `${ORG}/Widgets/_apis/wit`;
const ME = 'agent@acme.com';

interface Item { id: number; rev: number; fields: Record<string, unknown> }
interface Call { method: string; url: string; body: unknown }
type Op = { op: string; path: string; value: unknown };

/** An in-memory Azure DevOps work-item store speaking the REST shapes the sync uses. */
function fakeAdo(items: Item[], opts: { wiqlIds?: number[]; onPatch?: (id: number, ops: Op[]) => Partial<FetchResponse> | undefined; status?: number } = {}) {
  const store = new Map(items.map((i) => [i.id, i]));
  const calls: Call[] = [];
  const fetchJson = (async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    if (opts.status) return { status: opts.status, headers: { 'retry-after': '120' }, body: null };
    if (method === 'GET' && url === `${ORG}/_apis/connectionData`) {
      return { status: 200, headers: {}, body: { authenticatedUser: { properties: { Account: { $value: ME } } } } };
    }
    if (method === 'POST' && url === `${PROJ}/wiql?api-version=7.1`) {
      const ids = opts.wiqlIds ?? [...store.keys()];
      return { status: 200, headers: {}, body: { workItems: ids.map((id) => ({ id })) } };
    }
    if (method === 'POST' && url === `${PROJ}/workitemsbatch?api-version=7.1`) {
      const ids = (body as { ids: number[] }).ids;
      return { status: 200, headers: {}, body: { value: ids.map((id) => store.get(id)).filter(Boolean).map((i) => structuredClone(i)) } };
    }
    const m = /\/wit\/workitems\/(\d+)\?api-version=7\.1$/.exec(url);
    if (method === 'PATCH' && m) {
      const id = Number(m[1]);
      const ops = body as Op[];
      const forced = opts.onPatch?.(id, ops);
      if (forced) return { status: 200, headers: {}, body: null, ...forced };
      const item = store.get(id)!;
      for (const op of ops) {
        if (op.op === 'test' && op.path === '/rev' && op.value !== item.rev) {
          return { status: 412, headers: {}, body: { message: 'TF26071: This work item has been changed by someone else' } };
        }
      }
      for (const op of ops) if (op.op === 'add') item.fields[op.path.replace('/fields/', '')] = op.value;
      item.rev++;
      return { status: 200, headers: {}, body: structuredClone(item) };
    }
    throw new Error(`fakeAdo: unrouted ${method} ${url}`);
  }) as FetchJson;
  return { fetchJson, calls, store, patches: () => calls.filter((c) => c.method === 'PATCH') };
}

const story = (id: number, over: Record<string, unknown> = {}): Item => ({
  id, rev: 1,
  fields: { 'System.Title': `Story ${id}`, 'System.Description': `<div>Do <b>thing</b> ${id}</div>`, 'System.State': 'New', 'System.Tags': '', ...over },
});

function enabledCore(settings: Record<string, unknown> = {}): Core {
  const core = makeCore(ADO_ORIGIN);
  core.updateWorkspace('default', { adoSync: { enabled: true, ...settings } });
  return core;
}
const adoDeps = (core: Core, fetchJson: FetchJson, over: Parameters<typeof makeDeps>[2] = {}) =>
  makeDeps(core, fetchJson, { resolveOrigin: () => ADO_ORIGIN, ...over });
const tick = (core: Core, fetchJson: FetchJson, config = makeConfig(), over: Parameters<typeof makeDeps>[2] = {}) =>
  new Watcher(config, adoDeps(core, fetchJson, over)).tick();
const abTasks = (core: Core) => core.listTasks({ workspace: 'default' }).filter((t) => t.title.startsWith('AB#'));

describe('watcher — Azure DevOps work-item import (inbound)', () => {
  it('claims a new item, imports it as a queued spec-stage task, and tags it back', async () => {
    const core = enabledCore();
    const ado = fakeAdo([story(42)]);
    await tick(core, ado.fetchJson);

    const [t] = abTasks(core);
    expect(t).toMatchObject({ title: 'AB#42: Story 42', status: 'queued', stage: 'description' });
    const d = core.getTask(t!.key);
    expect(d.spec).toBe('ADO Work Item: AB#42 - https://dev.azure.com/acme/Widgets/_workitems/edit/42\n\nDo thing 42');
    expect(d.links).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'url', label: 'AB#42', url: 'https://dev.azure.com/acme/Widgets/_workitems/edit/42' })]));

    const query = (ado.calls.find((c) => c.url.includes('/wiql'))!.body as { query: string }).query;
    expect(query).toContain(`[System.AssignedTo] = '${ME}'`); // PAT owner from connectionData
    const [claim, mark] = ado.patches();
    expect(claim!.body).toEqual([
      { op: 'test', path: '/rev', value: 1 },
      { op: 'add', path: '/fields/System.AssignedTo', value: ME },
      { op: 'add', path: '/fields/System.State', value: 'Active' },
    ]);
    expect(mark!.body).toEqual(expect.arrayContaining([{ op: 'test', path: '/rev', value: 2 }]));
    const item = ado.store.get(42)!;
    expect(item.fields['System.State']).toBe('Active');
    expect(item.fields['System.Tags']).toBe(`agentfactory; AF:${t!.key}`);
    expect(String(item.fields['System.History'])).toContain(`Imported to AgentFactory as <b>${t!.key}</b>`);
  });

  it('uses assignTo when set (no identity lookup) and enters at implementation with the item\'s acceptance criteria', async () => {
    const core = enabledCore({ assignTo: 'bot@acme.com', stage: 'implementation' });
    const ado = fakeAdo([story(7, { 'Microsoft.VSTS.Common.AcceptanceCriteria': '<ul><li>works</li></ul>' })]);
    await tick(core, ado.fetchJson);

    expect(ado.calls.some((c) => c.url.includes('connectionData'))).toBe(false);
    const [t] = abTasks(core);
    expect(t).toMatchObject({ stage: 'implementation', status: 'queued' });
    expect(core.getTask(t!.key).acceptanceCriteria).toBe('- works');
    expect(ado.store.get(7)!.fields['System.AssignedTo']).toBe('bot@acme.com');
  });

  it('autoQueue off leaves imported tasks in backlog', async () => {
    const core = enabledCore({ autoQueue: false });
    await tick(core, fakeAdo([story(42)]).fetchJson);
    expect(abTasks(core)[0]!.status).toBe('backlog');
  });

  it('never duplicates a task the PowerShell bridge already imported, and re-queues it from backlog', async () => {
    const core = enabledCore();
    const old = core.createTask({ title: 'AB#42: Story 42', spec: 's', stage: 'description' });
    const ado = fakeAdo([story(42, { 'System.AssignedTo': { uniqueName: ME }, 'System.State': 'Active' })]);
    await tick(core, ado.fetchJson);

    expect(abTasks(core)).toHaveLength(1);
    expect(core.getTask(old.key).status).toBe('queued');
    // already claimed by us (recovery clause) → no claim PATCH, only the tag-back
    expect(ado.patches()).toHaveLength(1);
    expect(ado.store.get(42)!.fields['System.Tags']).toBe(`agentfactory; AF:${old.key}`);
  });

  it('skips an item whose claim lost a race (rev changed) without importing it', async () => {
    const core = enabledCore();
    const ado = fakeAdo([story(42)], { onPatch: () => ({ status: 412, body: { message: 'TF26071' } }) });
    await tick(core, ado.fetchJson);
    expect(abTasks(core)).toHaveLength(0);
  });

  it('caps imports per tick and picks the rest up next tick', async () => {
    const core = enabledCore({ maxImportsPerTick: 1 });
    const ado = fakeAdo([story(1), story(2)]);
    const w = new Watcher(makeConfig(), adoDeps(core, ado.fetchJson));
    await w.tick();
    expect(abTasks(core).map((t) => t.title)).toEqual(['AB#1: Story 1']);
    await w.tick();
    expect(abTasks(core)).toHaveLength(2);
  });

  it('a failure on one item does not stop the others', async () => {
    const core = enabledCore();
    const ado = fakeAdo([story(1), story(2)], { onPatch: (id, ops) => (id === 1 && ops.some((o) => o.path === '/fields/System.Tags') ? { status: 500 } : undefined) });
    await tick(core, ado.fetchJson);
    expect(abTasks(core)).toHaveLength(2);
    expect(ado.store.get(2)!.fields['System.Tags']).toContain('agentfactory');
  });
});

describe('watcher — Azure DevOps write-back (outbound)', () => {
  function imported(core: Core, id: number) {
    return core.importTask({
      workspace: 'default', title: `AB#${id}: Story ${id}`, spec: 's', acceptanceCriteria: 'a', stage: 'implementation',
      dedupPrefix: `AB#${id}:`, note: 'test', queue: true,
    }).task.key;
  }
  const toReview = (core: Core, key: string) => {
    core.claimNextTask({ taskKey: key, claimedBy: 'w' });
    core.submitResult(key, { summary: 'Shipped <the> export\nwith tests' });
  };

  it('implementation in review → reviewState, done → closeState with the result summary', async () => {
    const core = enabledCore();
    const reviewKey = imported(core, 10);
    toReview(core, reviewKey);
    const doneKey = imported(core, 11);
    toReview(core, doneKey);
    core.updateStatus(doneKey, 'done', 'human');
    const ado = fakeAdo(
      [story(10, { 'System.State': 'Active', 'System.Tags': 'agentfactory' }), story(11, { 'System.State': 'Resolved', 'System.Tags': 'agentfactory' })],
      { wiqlIds: [] },
    );
    await tick(core, ado.fetchJson);

    expect(ado.store.get(10)!.fields['System.State']).toBe('Resolved');
    expect(String(ado.store.get(10)!.fields['System.History'])).toContain(`<b>${reviewKey}</b> submitted for review`);
    expect(ado.store.get(11)!.fields['System.State']).toBe('Closed');
    expect(String(ado.store.get(11)!.fields['System.History'])).toContain('Shipped &lt;the&gt; export<br/>with tests');
  });

  it('leaves items it did not put in a managed state, and items already at the target', async () => {
    const core = enabledCore();
    const a = imported(core, 10);
    toReview(core, a);
    core.updateStatus(a, 'done', 'human');
    const b = imported(core, 11);
    toReview(core, b);
    core.updateStatus(b, 'done', 'human');
    const ado = fakeAdo([story(10, { 'System.State': 'Removed' }), story(11, { 'System.State': 'Closed' })], { wiqlIds: [] });
    await tick(core, ado.fetchJson);
    expect(ado.patches()).toHaveLength(0);
  });

  it('a doc-stage review never flips the item', async () => {
    const core = enabledCore();
    const key = core.importTask({ workspace: 'default', title: 'AB#12: S', spec: 's', stage: 'description', dedupPrefix: 'AB#12:', note: 'n', queue: true }).task.key;
    core.claimNextTask({ taskKey: key, claimedBy: 'w' });
    core.submitResult(key, { summary: 'spec', spec: 'the spec', acceptanceCriteria: 'ac' });
    const ado = fakeAdo([story(12, { 'System.State': 'Active' })], { wiqlIds: [] });
    await tick(core, ado.fetchJson);
    expect(ado.patches()).toHaveLength(0);
  });

  it('reviewState blank turns the in-review reflection off', async () => {
    const core = enabledCore({ reviewState: '' });
    toReview(core, imported(core, 10));
    const ado = fakeAdo([story(10, { 'System.State': 'Active' })], { wiqlIds: [] });
    await tick(core, ado.fetchJson);
    expect(ado.patches()).toHaveLength(0);
  });
});

describe('watcher — Azure DevOps sync gating and errors', () => {
  it('does nothing for a workspace without the import enabled', async () => {
    const core = makeCore(ADO_ORIGIN);
    const ado = fakeAdo([story(42)]);
    await tick(core, ado.fetchJson);
    expect(ado.calls).toHaveLength(0);
  });

  it('skips (and warns once) when the origin is not Azure DevOps', async () => {
    const core = enabledCore();
    const ado = fakeAdo([story(42)]);
    const warnings: string[] = [];
    const w = new Watcher(makeConfig(), adoDeps(core, ado.fetchJson, { resolveOrigin: () => GH_ORIGIN, console: { log: () => {}, error: () => {}, warn: (m: string) => warnings.push(m) } }));
    await w.tick();
    await w.tick();
    expect(ado.calls).toHaveLength(0);
    expect(warnings.filter((m) => m.includes('Azure DevOps'))).toHaveLength(1);
  });

  it('syncWorkItems: false turns the import off watcher-wide', async () => {
    const core = enabledCore();
    const ado = fakeAdo([story(42)]);
    await tick(core, ado.fetchJson, makeConfig({ syncWorkItems: false }));
    expect(ado.calls).toHaveLength(0);
  });

  it('a 429 pauses all polling; an auth failure names the missing scope and backs off', async () => {
    const core = enabledCore();
    const limited = fakeAdo([story(42)], { status: 429 });
    let now = 1_000_000;
    const w = new Watcher(makeConfig(), adoDeps(core, limited.fetchJson, { now: () => now }));
    await w.tick();
    const n = limited.calls.length;
    now += 60_000; // still inside retry-after (120 s)
    await w.tick();
    expect(limited.calls.length).toBe(n);

    const warnings: string[] = [];
    const denied = fakeAdo([story(42)], { status: 401 });
    await tick(enabledCore(), denied.fetchJson, makeConfig(), { console: { log: () => {}, error: () => {}, warn: (m: string) => warnings.push(m) } });
    expect(warnings.join('\n')).toMatch(/Work Items \(Read & write\)/);
  });
});
