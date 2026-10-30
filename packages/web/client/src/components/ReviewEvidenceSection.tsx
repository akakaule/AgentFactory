import type { EvidenceItem, EvidenceSourceKind } from '../types.js';

const SOURCE_LABEL: Record<EvidenceSourceKind, string> = { runner: 'Runner', reported: 'Reported', provider: 'Provider' };
const SOURCE_ORDER: Record<EvidenceSourceKind, number> = { runner: 0, reported: 1, provider: 2 };

/** "<Source> · <state> · <short sha or check name>". A worker's own report is never shown as a pass,
 *  and its free-text outcome is left out so it can't read like one. */
export function evidenceRow(e: EvidenceItem): string {
  const state = e.source === 'reported' ? 'unverified' : e.state;
  const detail = e.source === 'runner' ? (e.headSha ? e.headSha.slice(0, 7) : null)
    : e.source === 'provider' ? e.label || null : null;
  return [SOURCE_LABEL[e.source], state, detail].filter(Boolean).join(' · ');
}

/** The task's verification evidence (AF-171), runner first, so a runner-proven pass and a worker's claim never look alike. */
export function ReviewEvidenceSection({ evidence }: { evidence: EvidenceItem[] }) {
  const sorted = [...evidence].sort((a, b) => SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source]);
  return (
    <section className="af-rv-evidence" aria-label="Evidence">
      <span className="eyebrow">Evidence</span>
      {sorted.length === 0
        ? <p className="none">No verification evidence</p>
        : <ul>{sorted.map((e, i) => <li key={i} className={e.source === 'reported' ? 'unverified' : e.state} title={e.label || undefined}>{evidenceRow(e)}</li>)}</ul>}
    </section>
  );
}
