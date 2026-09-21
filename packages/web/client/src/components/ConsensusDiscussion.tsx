import type { ReviewConsensus } from '@agentfactory/core';

export function ConsensusDiscussion({ consensus }: { consensus: ReviewConsensus }) {
  const disputes = consensus.candidates.filter(c => c.outcome === 'disputed');
  return <>
    {disputes.length > 0 && <details className="af-airev-list">
      <summary className="hd">Needs human decision · {disputes.length} disputed finding{disputes.length === 1 ? '' : 's'}</summary>
      {disputes.map(c => <div className="it" key={c.id}><div className="bd">
        <strong className="ti">{c.finding.title}</strong>
        {c.finding.file && <div className="loc">{c.finding.file}{c.finding.line !== null ? `:${c.finding.line}` : ''}</div>}
        <p className="dt">{c.finding.detail}</p>
        {c.votes.map(v => <div key={v.reviewer} className="dt">
          <strong>{v.reviewer} · {v.decision}{v.severity ? ` · ${v.severity}` : ''}</strong>
          <p>{v.evidence}</p>
        </div>)}
      </div></div>)}
    </details>}
    <details className="af-airev-list">
      <summary className="hd">Review discussion · {consensus.participants.length} reviewers</summary>
      {consensus.history.map((h, i) => <details key={i} className="it" style={{ display: 'block' }}>
        <summary>{h.reviewer} · {h.phase}</summary>
        <pre style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', font: 'inherit' }}>{h.body}</pre>
      </details>)}
      {consensus.candidates.map(c => <details key={c.id} className="it" style={{ display: 'block' }}>
        <summary>{c.id} · {c.outcome} · {c.finding.title}</summary>
        <p>{c.finding.detail}</p>
        {c.votes.map(v => <p key={v.reviewer}>{v.reviewer}: {v.decision} ({v.severity ?? 'unclassified'}) — {v.evidence}{v.duplicateOf ? ` · duplicate of ${v.duplicateOf}` : ''}</p>)}
      </details>)}
    </details>
  </>;
}
