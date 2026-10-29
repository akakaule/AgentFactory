/** The one-line "what to do next" (AF-181), shared by the review panel and the drawer's status sections. */
export function NextAction({ sentence }: { sentence: string | null }) {
  if (!sentence) return null;
  return <p className="af-rv-next" aria-label="Next action">{sentence}</p>;
}
