import type { ReviewConsensus } from '@agentfactory/core';

/** The raw reviewer transcript behind the review panel — every message and candidate as posted.
 *  Collapsed at the bottom of the panel; the panel's issues are the curated reading of it. */
export function ConsensusDiscussion({ consensus }: { consensus: ReviewConsensus }) {
  const messages = consensus.history.length + consensus.candidates.length;
  return (
    <details className="af-airev-list af-rv-raw">
      <summary className="hd">{`Raw reviewer discussion · ${messages} message${messages === 1 ? '' : 's'}`}</summary>
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
  );
}
