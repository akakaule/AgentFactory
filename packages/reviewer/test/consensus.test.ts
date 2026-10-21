import { describe, expect, it } from 'vitest';
import { createConsensus, collectBallot, consensusReview } from '../src/consensus.js';

const finding = { title: 'Bug', severity: 'error' as const, file: 'a.ts', line: 1, detail: 'Bad state' };
const results = [{ reviewer: 'claude/fable', body: 'review A', findings: [finding] }, { reviewer: 'codex/astra', body: 'review B', findings: [] }];
const ballot = (decision = 'confirm', severity = 'error', extra = {}) => JSON.stringify({ votes: [{ id: 'F1', decision, severity, evidence: 'a.ts:1 proves it', duplicateOf: null }], ...extra });
describe('consensus discussion', () => {
  it.each([true, false])('preserves embedded Markdown fences in ballot evidence (fenced=%s)', fenced => {
    const s = createConsensus(results);
    const evidence = 'Example: ```json {"bad":true} ```';
    const json = JSON.stringify({ votes: [{ id: 'F1', decision: 'confirm', severity: 'error', evidence, duplicateOf: null }] });
    collectBallot(s, fenced ? '```json\n' + json + '\n```' : json);
    expect(s.ballots[0]?.ballot.votes[0]?.evidence).toBe(evidence);
  });
  it('merges duplicate candidates only when both reviewers confirm the same earlier target', () => {
    const s = createConsensus([results[0]!, { ...results[1]!, findings: [finding] }]);
    const votes = ['F1', 'F2'].map(id => ({ id, decision: 'confirm', severity: 'error', evidence: 'Same defect and remedy', duplicateOf: id === 'F2' ? 'F1' : null }));
    collectBallot(s, JSON.stringify({ votes })); collectBallot(s, JSON.stringify({ votes }));
    const payload = JSON.parse(consensusReview(s).split('```json\n')[1]!.split('\n```')[0]!);
    expect(payload.findings).toHaveLength(1);
    expect(payload.consensus.candidates).toHaveLength(2);
  });
  it('keeps candidates separate when only one reviewer calls them duplicates', () => {
    const s = createConsensus([results[0]!, { ...results[1]!, findings: [finding] }]);
    const votes = ['F1', 'F2'].map(id => ({ id, decision: 'confirm', severity: 'error', evidence: 'Verified', duplicateOf: null }));
    collectBallot(s, JSON.stringify({ votes })); collectBallot(s, JSON.stringify({ votes: votes.map(v => ({ ...v, duplicateOf: v.id === 'F2' ? 'F1' : null })) }));
    const payload = JSON.parse(consensusReview(s).split('```json\n')[1]!.split('\n```')[0]!);
    expect(payload.findings).toHaveLength(2);
  });
  it('confirms a finding the other reviewer initially missed without publishing early', () => {
    const s = createConsensus(results);
    collectBallot(s, ballot());
    expect(() => consensusReview(s)).toThrow();
    collectBallot(s, ballot());
    expect(s.phase).toBe('complete');
    expect(consensusReview(s)).toContain('"verdict":"findings"');
  });
  it('keeps split final votes disputed after one rebuttal exchange', () => {
    const s = createConsensus(results);
    collectBallot(s, ballot()); collectBallot(s, ballot('reject'));
    expect(s.phase).toBe('final-ballot');
    collectBallot(s, ballot()); collectBallot(s, ballot('reject'));
    expect(s.phase).toBe('complete');
    expect(consensusReview(s)).toContain('"verdict":"disputed"');
  });
  it('allows withdrawal after cross-examination', () => {
    const s = createConsensus(results);
    collectBallot(s, ballot()); collectBallot(s, ballot('reject'));
    collectBallot(s, ballot('reject')); collectBallot(s, ballot('reject'));
    expect(consensusReview(s)).toContain('"verdict":"clean"');
  });
  it('does not treat severity disagreement as confirmation', () => {
    const s = createConsensus(results);
    collectBallot(s, ballot()); collectBallot(s, ballot('confirm', 'warning'));
    expect(s.phase).toBe('final-ballot');
  });
  it.each([{ votes: [] }, { votes: [{ id: 'unknown' }] }, { votes: [JSON.parse(ballot()).votes[0], JSON.parse(ballot()).votes[0]] }])('rejects incomplete or invalid ballots', raw => {
    expect(() => collectBallot(createConsensus(results), JSON.stringify(raw))).toThrow();
  });
  it('retains a late new candidate as unresolved', () => {
    const s = createConsensus(results);
    collectBallot(s, ballot()); collectBallot(s, ballot('reject'));
    collectBallot(s, ballot('reject', 'error', { newFindings: [finding] })); collectBallot(s, ballot('reject'));
    expect(consensusReview(s)).toContain('"verdict":"disputed"');
  });
});
