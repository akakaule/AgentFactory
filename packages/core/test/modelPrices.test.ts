import { describe, it, expect } from 'vitest';
import { openCore, ValidationError } from '../src/index.js';
import { DEFAULT_MODEL_PRICES, priceUsage } from '../src/modelPrices.js';

describe('model prices: storage + validation', () => {
  it('reads the built-in defaults when nothing is stored', () => {
    const core = openCore(':memory:');
    expect(core.getModelPrices()).toEqual(DEFAULT_MODEL_PRICES);
    expect(core.getModelPrices()['gpt-6.1-sol']).toEqual({ input: 2, cachedInput: 0.1, output: 10 });
  });

  it('replaces the whole document, including with an empty one', () => {
    const core = openCore(':memory:');
    const doc = { 'gpt-6-luna': { input: 0.5, cachedInput: 0.05, output: 2 } };
    expect(core.setModelPrices(doc)).toEqual(doc);
    expect(core.getModelPrices()).toEqual(doc);
    expect(core.setModelPrices({})).toEqual({});
    expect(core.getModelPrices()).toEqual({}); // a cleared table stays cleared, not back to defaults
  });

  it('refuses bad ids and prices', () => {
    const core = openCore(':memory:');
    const price = { input: 1, cachedInput: 0.1, output: 4 };
    expect(() => core.setModelPrices({ 'bad id': price })).toThrow(ValidationError);
    expect(() => core.setModelPrices({ m: { ...price, input: -1 } })).toThrow(ValidationError);
    expect(() => core.setModelPrices({ m: { ...price, output: Number.NaN } })).toThrow(ValidationError);
    expect(() => core.setModelPrices({ m: { input: 1, output: 4 } })).toThrow(ValidationError);
    expect(() => core.setModelPrices({ m: { ...price, extra: 1 } })).toThrow(ValidationError);
    expect(() => core.setModelPrices([])).toThrow(ValidationError);
  });

  it('reads corrupt stored state as the defaults', () => {
    const core = openCore(':memory:');
    core.setKv('model_prices', '{not json');
    expect(core.getModelPrices()).toEqual(DEFAULT_MODEL_PRICES);
    core.setKv('model_prices', JSON.stringify({ m: { input: 'x' } }));
    expect(core.getModelPrices()).toEqual(DEFAULT_MODEL_PRICES);
  });
});

describe('priceUsage', () => {
  const prices = { 'gpt-6.1-sol': { input: 2, cachedInput: 0.2, output: 10 } };

  it('prices the uncached part of the input, the cached part and the output separately', () => {
    // 1M in of which 600k cached, 100k out: 400k·$2 + 600k·$0.20 + 100k·$10 per 1M = 0.8 + 0.12 + 1.0
    expect(priceUsage(prices, 'gpt-6.1-sol', { tokensIn: 1_000_000, tokensCached: 600_000, tokensOut: 100_000 })).toBeCloseTo(1.92, 10);
  });

  it('is undefined for a model without a price', () => {
    expect(priceUsage(prices, 'gpt-6-luna', { tokensIn: 10, tokensCached: 0, tokensOut: 10 })).toBeUndefined();
  });
});
