import { useEffect, useState } from 'react';
import type { ModelPrices } from '../types.js';
import { api } from '../api.js';
import { modelIdError } from '../agentModelMeta.js';

const FIELDS = [
  { key: 'input', label: 'input', head: 'Input' },
  { key: 'cachedInput', label: 'cached input', head: 'Cached input' },
  { key: 'output', label: 'output', head: 'Output' },
] as const;
type Field = (typeof FIELDS)[number]['key'];

/** One editable row: prices stay strings while typing; `isNew` rows have an editable id. */
interface Row { id: string; isNew: boolean; input: string; cachedInput: string; output: string }

const toRows = (prices: ModelPrices): Row[] =>
  Object.entries(prices).map(([id, p]) => ({ id, isNew: false, input: String(p.input), cachedInput: String(p.cachedInput), output: String(p.output) }));

const price = (s: string): number | null => {
  const n = s.trim() === '' ? Number.NaN : Number(s);
  return Number.isFinite(n) && n >= 0 && n <= 1000 ? n : null;
};

function rowsError(rows: Row[]): string | null {
  const ids = rows.map((r) => r.id.trim());
  const dup = ids.find((id, i) => id !== '' && ids.indexOf(id) !== i);
  if (dup) return `${dup} is listed more than once.`;
  if (ids.some((id) => id === '')) return 'Every row needs a model id.';
  const badId = ids.map((id) => modelIdError(id)).find((e) => e !== null);
  if (badId) return badId;
  if (rows.some((r) => FIELDS.some((f) => price(r[f.key]) === null))) return 'Prices must be non-negative numbers (max 1000).';
  return null;
}

const toPrices = (rows: Row[]): ModelPrices =>
  Object.fromEntries(rows.map((r) => [r.id.trim(), { input: price(r.input)!, cachedInput: price(r.cachedInput)!, output: price(r.output)! }]));

/** Agents › Prices: USD per 1M tokens for models whose CLI reports no cost (Codex). Save sends the
 *  whole table; the OTLP receiver prices each event as it arrives. */
export function ModelPricesPanel({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<ModelPrices | null>(null);
  const [rows, setRows] = useState<Row[]>([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [estimating, setEstimating] = useState(false);
  const [estimated, setEstimated] = useState<string | null>(null);

  const load = (prices: ModelPrices) => { setLoaded(prices); setRows(toRows(prices)); };
  useEffect(() => { api.getModelPrices().then((v) => load(v.prices)).catch((e: Error) => setErr(e.message)); }, []);

  if (!loaded) return <div style={{ color: 'var(--ink-3)' }}>{err ? <span className="af-err">{err}</span> : 'Loading…'}</div>;

  const invalid = rowsError(rows);
  const unsaved = invalid !== null || JSON.stringify(toPrices(rows)) !== JSON.stringify(loaded);
  const edit = (next: Row[]) => { setRows(next); setSaved(false); };
  const setField = (i: number, field: Field | 'id', value: string) => edit(rows.map((r, j) => (j === i ? { ...r, [field]: value } : r)));

  const save = () => {
    setSaving(true);
    setErr(null);
    api.setModelPrices(toPrices(rows))
      .then((v) => { load(v.prices); setSaved(true); })
      .catch((e: Error) => setErr(e.message))
      .finally(() => setSaving(false));
  };

  const estimatePast = () => {
    setEstimating(true);
    setErr(null);
    api.estimatePastCosts()
      .then((r) => setEstimated(r.rows === 0
        ? 'No past usage left to price with these models.'
        : `Priced ${r.rows} past usage rows: about $${r.usd.toFixed(2)}, estimated at 90% cached input.`))
      .catch((e: Error) => setErr(e.message))
      .finally(() => setEstimating(false));
  };

  return (
    <div className="af-models">
      <section className="af-mcard" aria-label="Model prices">
        <table className="af-prices">
          <thead>
            <tr><th>Model</th>{FIELDS.map((f) => <th key={f.key}>{f.head} <span className="af-prices-unit">$/1M</span></th>)}<th aria-label="Actions" /></tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const name = r.id.trim() || 'new model';
              return (
                <tr key={i}>
                  <td>
                    {r.isNew
                      ? <input aria-label="New model id" className="mono" value={r.id} placeholder="model id" onChange={(e) => setField(i, 'id', e.target.value)} />
                      : <code className="mono">{r.id}</code>}
                  </td>
                  {FIELDS.map((f) => (
                    <td key={f.key}>
                      <input aria-label={`${name} ${f.label}`} inputMode="decimal" value={r[f.key]} onChange={(e) => setField(i, f.key, e.target.value)} />
                    </td>
                  ))}
                  <td><button type="button" className="af-mini danger" aria-label={`Remove ${name}`} onClick={() => edit(rows.filter((_, j) => j !== i))}>Remove</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <p className="af-mcard-hint">No prices: Codex rows show no cost.</p>}
        {invalid && <div className="af-err" role="alert">{invalid}</div>}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" className="af-mini" onClick={() => edit([...rows, { id: '', isNew: true, input: '', cachedInput: '', output: '' }])}>+ Add model</button>
          <button type="button" className="af-mini" disabled={estimating || unsaved} onClick={estimatePast}
            title={unsaved ? 'Save the prices first' : 'Price usage recorded before these models had a price (estimated, assuming 90% of input was cached)'}>
            {estimating ? 'Pricing…' : 'Price past usage'}
          </button>
          {estimated && <span className="af-mcard-hint" role="status">{estimated}</span>}
        </div>
      </section>
      {err && <div className="af-err" style={{ marginTop: '8px' }}>{err}</div>}
      <footer className="af-models-foot">
        <span className="af-models-count">{unsaved ? 'Unsaved changes' : saved ? 'Saved' : 'No unsaved changes'}</span>
        <button type="button" className="af-mini" onClick={onClose}>Cancel</button>
        <button type="button" className="af-btn-primary" disabled={saving || !unsaved || invalid !== null} onClick={save}>
          {saving ? 'Saving…' : 'Save'}
        </button>
      </footer>
      <p className="af-mcard-hint">
        Prices Codex usage as each event arrives (Claude reports its own cost). Price past usage fills in older
        unpriced rows as an estimate (90% cached input), marked ≈. Use the standard API rates: fast mode and very
        long prompts bill higher, so those rows are estimates.
      </p>
    </div>
  );
}
