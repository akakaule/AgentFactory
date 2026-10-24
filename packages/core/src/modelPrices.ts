/**
 * Board-editable model prices (app_kv, JSON): USD per 1M tokens for models whose CLI reports token
 * counts but no cost. Codex's OTel events carry only `*_token_count`s, so the OTLP receiver prices
 * them on arrival from this table; Claude reports its own `cost_usd`, which always wins. Applied as
 * events arrive, never retroactively (task_metric keeps no cached-token split to re-price from).
 *
 * Nothing stored reads as the built-in defaults; a saved table — even an empty one — replaces them.
 * Corrupt stored state reads as the defaults, the same rule `engine_settings` uses.
 */
import { z } from 'zod';
import type { DB } from './db.js';
import { getKv, setKv } from './repo/kv.js';
import { MODEL_ID_PATTERN } from './agentModels.js';
import { parse } from './validate.js';

/** USD per 1M tokens. `cachedInput` prices the cache-hit part of the input. */
export interface ModelPrice { input: number; cachedInput: number; output: number }
export type ModelPrices = Record<string, ModelPrice>;

/** GPT-6.1 Sol's standard OpenAI API rates. Fast mode doubles them and requests above 272K input
 *  tokens bill higher, so for those a single entry is an estimate. */
export const DEFAULT_MODEL_PRICES: Readonly<ModelPrices> = {
  'gpt-6.1-sol': { input: 2, cachedInput: 0.1, output: 10 },
};

const KV_KEY = 'model_prices';
const MAX_MODELS = 100;

const usd = z.number().finite().nonnegative().max(1000);
const priceSchema = z.object({ input: usd, cachedInput: usd, output: usd }).strict();
const pricesSchema = z.record(z.string().regex(MODEL_ID_PATTERN, 'model id may only use letters, digits and . _ : [ ] - (max 80, starting alphanumeric)'), priceSchema)
  .refine((p) => Object.keys(p).length <= MAX_MODELS, `at most ${MAX_MODELS} models`);

const defaults = (): ModelPrices => structuredClone(DEFAULT_MODEL_PRICES) as ModelPrices;

export function getModelPrices(db: DB): ModelPrices {
  const raw = getKv(db, KV_KEY);
  if (raw === null) return defaults();
  try {
    const r = pricesSchema.safeParse(JSON.parse(raw));
    return r.success ? r.data : defaults();
  } catch { return defaults(); }
}

/** Validate and replace the WHOLE table. */
export function setModelPrices(db: DB, input: unknown): ModelPrices {
  const prices = parse(pricesSchema, input);
  setKv(db, KV_KEY, JSON.stringify(prices));
  return prices;
}

/** The cost of one usage record, or undefined when the model has no price. `tokensIn` includes the
 *  cached part (OpenAI usage semantics), so only the remainder is billed at the full input rate. */
export function priceUsage(prices: ModelPrices, model: string, usage: { tokensIn: number; tokensCached: number; tokensOut: number }): number | undefined {
  const p = Object.hasOwn(prices, model) ? prices[model] : undefined;
  if (!p) return undefined;
  const cached = Math.min(usage.tokensCached, usage.tokensIn);
  return ((usage.tokensIn - cached) * p.input + cached * p.cachedInput + usage.tokensOut * p.output) / 1_000_000;
}
