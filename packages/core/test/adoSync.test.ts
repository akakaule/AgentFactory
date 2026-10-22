import { describe, it, expect } from 'vitest';
import { adoSyncSettingsSchema, defaultAdoSyncSettings, parseAdoSyncSettings, buildInboundWiql, htmlToText, adoIdFromTitle } from '../src/adoSync.js';

const base = { ...defaultAdoSyncSettings(), workItemTypes: ['User Story'], states: ['New'], claimState: 'Active', markerTag: 'agentfactory' };
const AGENT = 'agent@example.com';

// Ported from ado-bridge tests/Test-InboundWiql.ps1 — the query must stay byte-compatible.
describe('buildInboundWiql', () => {
  it('default config: unassigned new items, recovery clause, backlog order, no path filters', () => {
    const q = buildInboundWiql(base, AGENT);
    expect(q).toContain("([System.AssignedTo] = '' AND [System.State] IN ('New'))");
    expect(q).toContain("([System.AssignedTo] = 'agent@example.com' AND [System.State] = 'Active' AND [System.Tags] NOT CONTAINS 'agentfactory')");
    expect(q).toContain('ORDER BY [Microsoft.VSTS.Common.StackRank] ASC, [System.ChangedDate] ASC');
    expect(q).not.toContain('AreaPath');
    expect(q).not.toContain('IterationPath');
    expect(q).toContain("[System.WorkItemType] = 'User Story'");
    expect(q.startsWith('SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = @project AND ')).toBe(true);
  });

  it('requiredTag gates on the tag and takes over assigned items', () => {
    const q = buildInboundWiql({ ...base, requiredTag: 'ai-agent' }, AGENT);
    expect(q).toContain("[System.Tags] CONTAINS 'ai-agent'");
    expect(q).toContain("([System.State] IN ('New'))");
    expect(q).not.toContain("[System.AssignedTo] = ''");
  });

  it('lists several new states', () => {
    expect(buildInboundWiql({ ...base, states: ['New', 'Approved'] }, AGENT)).toContain("IN ('New', 'Approved')");
  });

  it('adds area and iteration UNDER filters', () => {
    const q = buildInboundWiql({ ...base, areaPath: 'PMD\\Area', iterationPath: 'PMD\\Sprint 5' }, AGENT);
    expect(q).toContain("[System.AreaPath] UNDER 'PMD\\Area'");
    expect(q).toContain("[System.IterationPath] UNDER 'PMD\\Sprint 5'");
  });

  it('honours an orderBy override', () => {
    const q = buildInboundWiql({ ...base, orderBy: '[Microsoft.VSTS.Common.Priority] ASC' }, AGENT);
    expect(q).toContain('ORDER BY [Microsoft.VSTS.Common.Priority] ASC');
    expect(q).not.toContain('StackRank');
  });

  it("escapes single quotes as ''", () => {
    expect(buildInboundWiql({ ...base, areaPath: "Team O'Brien" }, AGENT)).toContain("UNDER 'Team O''Brien'");
  });

  it('several work item types use IN', () => {
    expect(buildInboundWiql({ ...base, workItemTypes: ['User Story', 'Bug'] }, AGENT)).toContain("[System.WorkItemType] IN ('User Story', 'Bug')");
  });

  it('the @Me macro stays unquoted', () => {
    expect(buildInboundWiql(base, '@Me')).toContain('([System.AssignedTo] = @Me AND');
  });
});

describe('adoSyncSettingsSchema', () => {
  it('fills the ado-bridge (Agile) defaults', () => {
    expect(adoSyncSettingsSchema.parse({})).toEqual({
      enabled: false, workItemTypes: ['User Story'], states: ['New'], areaPath: '', iterationPath: '', requiredTag: '', orderBy: '',
      assignTo: '', claimState: 'Active', reviewState: 'Resolved', closeState: 'Closed', markerTag: 'agentfactory',
      stage: 'description', autoQueue: true, maxDescriptionChars: 8000, maxImportsPerTick: 10,
    });
  });

  it('converts / to \ in area and iteration paths, and trims', () => {
    const s = adoSyncSettingsSchema.parse({ areaPath: ' PMD/Sprint 5 ', iterationPath: 'A/B' });
    expect(s.areaPath).toBe('PMD\\Sprint 5');
    expect(s.iterationPath).toBe('A\\B');
  });

  it('rejects a requiredTag equal to the markerTag', () => {
    expect(adoSyncSettingsSchema.safeParse({ requiredTag: 'agentfactory' }).success).toBe(false);
  });

  it('rejects empty lists, blank claim/close states and unknown keys', () => {
    expect(adoSyncSettingsSchema.safeParse({ states: [] }).success).toBe(false);
    expect(adoSyncSettingsSchema.safeParse({ closeState: ' ' }).success).toBe(false);
    expect(adoSyncSettingsSchema.safeParse({ organization: 'x' }).success).toBe(false);
  });

  it('allows reviewState to be blank (reflection off)', () => {
    expect(adoSyncSettingsSchema.parse({ reviewState: '' }).reviewState).toBe('');
  });
});

describe('parseAdoSyncSettings', () => {
  it('null / corrupt / invalid stored JSON reads as null (off)', () => {
    expect(parseAdoSyncSettings(null)).toBeNull();
    expect(parseAdoSyncSettings('{not json')).toBeNull();
    expect(parseAdoSyncSettings('{"states":[]}')).toBeNull();
  });
  it('a stored object round-trips with defaults filled', () => {
    expect(parseAdoSyncSettings('{"enabled":true}')).toEqual({ ...defaultAdoSyncSettings(), enabled: true });
  });
});

describe('htmlToText', () => {
  it('turns block ends and <br> into newlines, list items into dashes, and strips other tags', () => {
    expect(htmlToText('<div>One<br/>Two</div><ul><li>a</li><li class="x">b</li></ul><p><b>bold</b></p>', 0))
      .toBe('One\nTwo\n- a\n- b\nbold');
  });
  it('decodes entities after stripping tags', () => {
    expect(htmlToText('&lt;tag&gt; &amp; &quot;q&quot; &#39;s&#39; &nbsp;x &#x41;', 0)).toBe('<tag> & "q" \'s\'  x A');
  });
  it('collapses three or more line breaks into one blank line and trims', () => {
    expect(htmlToText('<p>a</p><p></p><p></p><p>b</p>', 0)).toBe('a\n\nb');
  });
  it('truncates with a marker', () => {
    expect(htmlToText('abcdefghij', 4)).toBe('abcd\n... (truncated)');
  });
  it('blank input gives empty text', () => {
    expect(htmlToText(null, 10)).toBe('');
    expect(htmlToText('   ', 10)).toBe('');
  });
});

describe('adoIdFromTitle', () => {
  it('reads the AB# prefix', () => {
    expect(adoIdFromTitle('AB#123: Do a thing')).toBe(123);
    expect(adoIdFromTitle('ADO-PR #5: x')).toBeNull();
    expect(adoIdFromTitle('Fix AB#12: no')).toBeNull();
  });
});
