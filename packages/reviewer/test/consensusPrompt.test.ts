import { describe, expect, it } from 'vitest';
import { buildConsensusPrompt } from '../src/consensusPrompt.js';
import { createConsensus, collectBallot } from '../src/consensus.js';

describe('consensus phase evidence', () => {
  it('shares completed phases while hiding the current reviewer ballot until the barrier', () => {
    const state = createConsensus([{ reviewer: 'A', body: 'Original A', findings: [{ title: 'Bug', severity: 'error', file: null, line: null, detail: 'Proof' }] }, { reviewer: 'B', body: 'Original B', findings: [] }]);
    const vote = (decision: string) => JSON.stringify({ votes: [{ id: 'F1', decision, severity: 'error', evidence: 'Cross-examination evidence', duplicateOf: null }] });
    collectBallot(state, vote('confirm'));
    expect(buildConsensusPrompt('Pinned snapshot', state)).not.toContain('Cross-examination evidence');
    collectBallot(state, vote('reject'));
    expect(buildConsensusPrompt('Pinned snapshot', state)).toContain('Cross-examination evidence');
    expect(() => buildConsensusPrompt('Pinned snapshot', state, 10)).toThrow('no candidates were omitted');
  });
  it('asks each vote for a plain reason and late findings for criteria and a fix', () => {
    const state = createConsensus([{ reviewer: 'A', body: 'A', findings: [{ title: 'Bug', severity: 'error', file: null, line: null, detail: 'Proof', criteria: ['AC1'] }] }, { reviewer: 'B', body: 'B', findings: [] }]);
    const prompt = buildConsensusPrompt('Pinned snapshot', state);
    expect(prompt).toContain('"reason":"one plain sentence: why this decision and severity"');
    expect(prompt).toContain('{title,severity,file,line,criteria,detail,fix}');
    expect(prompt).toContain('"criteria":["AC1"]'); // the candidate's links ride into the discussion
  });
});
