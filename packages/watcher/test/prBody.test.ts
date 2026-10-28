import { describe, it, expect } from 'vitest';
import { expectedRevisionOf, type Core } from '@agentfactory/core';
import { Watcher } from '../src/watcher.js';
import { SECTION_BEGIN, SECTION_END, fitBody, renderSection, withSection } from '../src/prBody.js';
import type { FetchJson, FetchResponse } from '../src/types.js';
import { ADO_ORIGIN, makeConfig, makeCore, makeDeps } from './helpers.js';

/**
 * The delivery PR body carries a board-managed section between the agentfactory markers: the
 * watcher writes it at creation and keeps it current on every poll of an open PR, never touching
 * the text outside the markers.
 */

interface Call { method: string; url: string; body: unknown }
type Handler = (method: string, url: string, body: unknown) => Partial<FetchResponse> | undefined;

function apiFake(handler: Handler): FetchJson & { calls: Call[] } {
  const calls: Call[] = [];
  const fn = (async (url, init) => {
    const method = init.method ?? 'GET';
    const body = init.body ? JSON.parse(init.body) as unknown : undefined;
    calls.push({ method, url, body });
    const res = handler(method, url, body);
    if (!res) throw new Error(`apiFake: unrouted ${method} ${url}`);
    return { status: 200, headers: {}, body: null, ...res };
  }) as FetchJson & { calls: Call[] };
  fn.calls = calls;
  return fn;
}

const GH_REPO = 'https://api.github.com/repos/o/r';
const ADO_BASE = 'https://dev.azure.com/acme/Widgets/_apis/git/repositories/widgets';
const patches = (f: { calls: Call[] }) => f.calls.filter((c) => c.method === 'PATCH');

/** create (with one AC) → claim → submit with an AC1 claim → approve ⇒ delivering. */
function deliverWithClaims(core: Core, title = 'Ship the widget'): string {
  const t = core.createTask({ title, spec: 'spec', acceptanceCriteria: '1. Works — it works.' });
  core.updateStatus(t.key, 'queued', 'human');
  core.claimNextTask({ claimedBy: 'worker-1' });
  core.submitResult(t.key, { summary: 'Built the widget.\n\nMore detail below.', criteria: [{ id: 'AC1', claim: 'widget.test.ts proves it' }] });
  const approved = core.reviewApprove(t.key, undefined, undefined, expectedRevisionOf(core.getTask(t.key)));
  if (approved.status !== 'delivering') throw new Error(`expected delivering, got ${approved.status}`);
  return t.key;
}

describe('withSection', () => {
  it('rewrites only the text between the markers', () => {
    const body = `Human intro\n${SECTION_BEGIN}old${SECTION_END}\nHuman outro`;
    expect(withSection(body, 'new')).toBe(`Human intro\n${SECTION_BEGIN}new${SECTION_END}\nHuman outro`);
  });

  it('appends the section once to a body without markers', () => {
    const once = withSection('Human only', 'x');
    expect(once).toBe(`Human only\n\n${SECTION_BEGIN}x${SECTION_END}`);
    expect(withSection(once, 'x')).toBe(once);
  });

  it('fitBody shortens the human text before the section, keeping both markers', () => {
    const body = withSection('h'.repeat(5000), 'x');
    const fitted = fitBody(body, 4000);
    expect(fitted.length).toBeLessThanOrEqual(4000);
    expect(fitted.endsWith(`${SECTION_BEGIN}x${SECTION_END}`)).toBe(true);
  });

  it('an empty body becomes just the section', () => {
    expect(withSection('', 'x')).toBe(`${SECTION_BEGIN}x${SECTION_END}`);
  });
});

describe('renderSection within a length budget', () => {
  const task = (summary: string, claims: Array<{ id: string; claim: string }>) =>
    ({ key: 'AF-1', title: 'Ship the widget', resultSummary: summary, criteriaClaims: claims });

  it('a long summary is shortened before any acceptance claim is dropped', () => {
    const content = renderSection(task('s'.repeat(3100), [{ id: 'AC1', claim: 'widget.test.ts proves it' }]))!;
    expect(content.length).toBeLessThanOrEqual(3000);
    expect(content).toContain('AF-1');
    expect(content).toContain('Ship the widget');
    expect(content).toContain('**AC1** — widget.test.ts proves it');
  });

  it('long claims are shortened, but every claim entry stays', () => {
    const claims = Array.from({ length: 8 }, (_, i) => ({ id: `AC${i + 1}`, claim: 'c'.repeat(600) }));
    const content = renderSection(task('summary', claims), 1200)!;
    expect(content.length).toBeLessThanOrEqual(1200);
    for (const c of claims) expect(content).toContain(`**${c.id}**`);
  });

  it('returns null when not even the key, title and claim ids fit', () => {
    expect(renderSection(task('summary', [{ id: 'AC1', claim: 'x' }]), 20)).toBeNull();
  });
});

describe('watcher-created PR body', () => {
  it('carries the section once, with the key, title and AC claims', async () => {
    const core = makeCore();
    const key = deliverWithClaims(core, 'Ship the widget');
    const fetchJson = apiFake((method, url) => {
      if (method === 'GET' && url === 'https://api.github.com/repos/acme/widgets') return { body: { default_branch: 'main' } };
      if (method === 'GET' && url.includes('/pulls?head=')) return { body: [] };
      if (method === 'POST' && url.endsWith('/pulls')) return { status: 201, body: { number: 43, html_url: 'https://github.com/acme/widgets/pull/43', state: 'open', merged_at: null, head: { sha: 'h' }, merge_commit_sha: null } };
      return undefined;
    });
    await new Watcher(makeConfig(), makeDeps(core, fetchJson)).tick();

    const post = fetchJson.calls.find((c) => c.method === 'POST')!;
    const body = (post.body as { body: string }).body;
    expect(body.split(SECTION_BEGIN)).toHaveLength(2);
    expect(body.split(SECTION_END)).toHaveLength(2);
    const inner = body.slice(body.indexOf(SECTION_BEGIN) + SECTION_BEGIN.length, body.indexOf(SECTION_END));
    expect(inner).toContain(key);
    expect(inner).toContain('Ship the widget');
    expect(inner).toContain('AC1');
    expect(inner).toContain('widget.test.ts proves it');
    expect(inner).toContain('Built the widget.');
    expect(inner).not.toContain('More detail below.'); // first paragraph only
  });
});

/** One host's stub: an open PR #7 whose body the test controls; PATCH updates it. */
interface Host {
  name: string;
  origin: string;
  make(core: Core, initialBody: string): { fetchJson: FetchJson & { calls: Call[] }; deps: ReturnType<typeof makeDeps> };
  patchUrl: (url: string) => boolean;
  patchedBody: (b: unknown) => string;
}

const github: Host = {
  name: 'GitHub',
  origin: 'https://github.com/o/r.git',
  make(core, initialBody) {
    let body = initialBody;
    const pr = () => ({ number: 7, html_url: 'https://github.com/o/r/pull/7', state: 'open', merged_at: null, head: { sha: 'h' }, merge_commit_sha: null, body });
    const fetchJson = apiFake((method, url, sent) => {
      if (method === 'GET' && url.startsWith(`${GH_REPO}/pulls?head=`)) return { body: [pr()] };
      if (method === 'GET' && url === `${GH_REPO}/pulls/7`) return { body: pr() };
      if (method === 'PATCH' && url === `${GH_REPO}/pulls/7`) { body = (sent as { body: string }).body; return { body: pr() }; }
      if (method === 'GET' && url.includes('/check-runs')) return { body: { check_runs: [] } };
      if (method === 'GET' && url.endsWith('/status')) return { body: { statuses: [] } };
      return undefined;
    });
    return { fetchJson, deps: makeDeps(core, fetchJson, { resolveOrigin: () => 'https://github.com/o/r.git' }) };
  },
  patchUrl: (url) => url === `${GH_REPO}/pulls/7`,
  patchedBody: (b) => (b as { body: string }).body,
};

const azdo: Host = {
  name: 'Azure DevOps',
  origin: ADO_ORIGIN,
  make(core, initialBody) {
    let description = initialBody;
    const pr = () => ({ pullRequestId: 7, status: 'active', mergeStatus: 'succeeded', lastMergeSourceCommit: { commitId: 'src' }, lastMergeCommit: { commitId: 'm' }, description });
    const fetchJson = apiFake((method, url, sent) => {
      if (method === 'GET' && url.startsWith(`${ADO_BASE}/pullrequests?searchCriteria`)) return { body: { value: [pr()] } };
      if (method === 'GET' && url.startsWith(`${ADO_BASE}/pullrequests/7?`)) return { body: pr() };
      if (method === 'PATCH' && url.startsWith(`${ADO_BASE}/pullrequests/7?`)) { description = (sent as { description: string }).description; return { body: pr() }; }
      if (method === 'GET' && url.includes('/statuses')) return { body: { value: [] } };
      return undefined;
    });
    return { fetchJson, deps: makeDeps(core, fetchJson, { resolveOrigin: () => ADO_ORIGIN }) };
  },
  patchUrl: (url) => url.startsWith(`${ADO_BASE}/pullrequests/7?`),
  patchedBody: (b) => (b as { description: string }).description,
};

describe.each([github, azdo])('$name: keeping the section current', (host) => {
  const setup = (body: (content: string) => string) => {
    const core = makeCore(host.origin);
    const key = deliverWithClaims(core);
    const content = renderSection(core.getTask(key))!;
    const { fetchJson, deps } = host.make(core, body(content));
    return { core, key, content, fetchJson, watcher: new Watcher(makeConfig(), deps) };
  };

  it('in place: rewrites only between the markers', async () => {
    const { content, fetchJson, watcher } = setup(() => `Human intro\n${SECTION_BEGIN}old${SECTION_END}\nHuman outro`);
    await watcher.tick();
    const sent = patches(fetchJson);
    expect(sent).toHaveLength(1);
    expect(host.patchUrl(sent[0]!.url)).toBe(true);
    expect(host.patchedBody(sent[0]!.body)).toBe(`Human intro\n${SECTION_BEGIN}${content}${SECTION_END}\nHuman outro`);
  });

  it('no churn: a current section sends no PATCH', async () => {
    const { fetchJson, watcher } = setup((content) => `Intro\n${SECTION_BEGIN}${content}${SECTION_END}`);
    await watcher.tick();
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(0);
  });

  it('no churn: CRLF line endings from a web edit are not a difference', async () => {
    const { fetchJson, watcher } = setup((content) => `Intro\r\n${SECTION_BEGIN}${content.replace(/\n/g, '\r\n')}${SECTION_END}`);
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(0);
  });

  it('append once: a body without markers gets the section on the first poll only', async () => {
    const { content, fetchJson, watcher } = setup(() => 'Human only');
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(1);
    expect(host.patchedBody(patches(fetchJson)[0]!.body)).toBe(`Human only\n\n${SECTION_BEGIN}${content}${SECTION_END}`);
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(1);
  });

  it('a failed PATCH is logged and does not stop the poll', async () => {
    const core = makeCore(host.origin);
    const key = deliverWithClaims(core);
    const { fetchJson } = host.make(core, 'Human only');
    const failing = (async (url, init) => {
      if (init.method === 'PATCH') return { status: 500, headers: {}, body: null };
      return fetchJson(url, init);
    }) as FetchJson;
    const warns: string[] = [];
    const deps = makeDeps(core, failing, { resolveOrigin: () => host.origin, console: { log: () => {}, warn: (m: string) => warns.push(m), error: () => {} } });
    await new Watcher(makeConfig(), deps).tick();
    expect(core.getTask(key).delivery).toMatchObject({ prState: 'open' });
    expect(warns.some((w) => w.includes('PR body'))).toBe(true);
  });
});

describe('Azure DevOps 4000-character description limit', () => {
  const setup = (initialBody: string) => {
    const core = makeCore(ADO_ORIGIN);
    const key = deliverWithClaims(core);
    const { fetchJson } = azdo.make(core, initialBody);
    const warns: string[] = [];
    const deps = makeDeps(core, fetchJson, { resolveOrigin: () => ADO_ORIGIN, console: { log: () => {}, warn: (m: string) => warns.push(m), error: () => {} } });
    return { key, fetchJson, warns, watcher: new Watcher(makeConfig(), deps) };
  };

  it('fits the section into the room left, keeping the human intro and outro exactly', async () => {
    const intro = `${'i'.repeat(3650)}\n`;
    const outro = `\n${'o'.repeat(200)}`;
    const { fetchJson, watcher } = setup(`${intro}${SECTION_BEGIN}old${SECTION_END}${outro}`);
    await watcher.tick();
    const sent = patches(fetchJson);
    expect(sent).toHaveLength(1);
    const body = azdo.patchedBody(sent[0]!.body);
    expect(body.length).toBeLessThanOrEqual(4000);
    expect(body.startsWith(`${intro}${SECTION_BEGIN}`)).toBe(true);
    expect(body.endsWith(`${SECTION_END}${outro}`)).toBe(true);
    expect(body).toContain('**AC1**');
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(1); // the fitted section is current on the next poll
  });

  it('leaves a near-limit human description unchanged and logs it', async () => {
    const human = 'h'.repeat(3980);
    const { fetchJson, warns, watcher } = setup(human);
    await watcher.tick();
    expect(patches(fetchJson)).toHaveLength(0);
    expect(warns.some((w) => w.includes('PR body'))).toBe(true);
  });

  it('GitHub has room for the same near-limit description and appends without cutting it', async () => {
    const core = makeCore(github.origin);
    deliverWithClaims(core);
    const human = 'h'.repeat(3980);
    const { fetchJson, deps } = github.make(core, human);
    await new Watcher(makeConfig(), deps).tick();
    const body = github.patchedBody(patches(fetchJson)[0]!.body);
    expect(body.startsWith(`${human}\n\n${SECTION_BEGIN}`)).toBe(true);
  });
});
