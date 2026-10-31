import type { DB } from '../db.js';
import { transaction } from '../transaction.js';
import { priceUsage, type ModelPrices } from '../modelPrices.js';

/** Share of a past report's input assumed to have been cache hits. task_metric keeps no cached
 *  split, and agent sessions re-send their context every turn, so most input is cached. */
export const PAST_COST_CACHED_SHARE = 0.9;

/**
 * Fill in the cost of usage that arrived before its model had a price: every task_metric row with
 * tokens but no cost whose model is in `prices` is priced at PAST_COST_CACHED_SHARE cached input and
 * marked `cost_estimated`. Rows with a reported cost are never touched; re-running is a no-op.
 */
export function estimatePastCosts(db: DB, prices: ModelPrices): { rows: number; usd: number } {
  return transaction(db, () => {
    const rows = db.prepare(
      `SELECT id, model, tokens_in, tokens_out FROM task_metric
       WHERE cost_usd IS NULL AND model IS NOT NULL AND (tokens_in IS NOT NULL OR tokens_out IS NOT NULL)`,
    ).all() as Array<{ id: number; model: string; tokens_in: number | null; tokens_out: number | null }>;
    const update = db.prepare('UPDATE task_metric SET cost_usd = ?, cost_estimated = 1 WHERE id = ? AND cost_usd IS NULL');
    let count = 0;
    let usd = 0;
    for (const r of rows) {
      const tokensIn = r.tokens_in ?? 0;
      const cost = priceUsage(prices, r.model, {
        tokensIn, tokensCached: Math.round(tokensIn * PAST_COST_CACHED_SHARE), tokensOut: r.tokens_out ?? 0,
      });
      if (cost === undefined) continue;
      update.run(cost, r.id);
      count += 1;
      usd += cost;
    }
    return { rows: count, usd: Math.round(usd * 100) / 100 };
  });
}
