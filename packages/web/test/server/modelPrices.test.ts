import { describe, it, expect, beforeEach } from 'vitest';
import { openCore, DEFAULT_MODEL_PRICES } from '@agentfactory/core';
import { buildApp } from '../../server/app.js';

const put = (app: ReturnType<typeof buildApp>, body: unknown, headers: Record<string, string> = {}) =>
  app.request('/api/model-prices', { method: 'PUT', body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers } });

describe('model-prices REST API', () => {
  let core: ReturnType<typeof openCore>;
  let app: ReturnType<typeof buildApp>;

  beforeEach(() => {
    core = openCore(':memory:');
    app = buildApp(core);
  });

  it('GET returns the built-in defaults until a table is saved', async () => {
    const res = await app.request('/api/model-prices');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prices: DEFAULT_MODEL_PRICES });
  });

  it('PUT replaces the whole table', async () => {
    const prices = { 'gpt-6-astra': { input: 1, cachedInput: 0.1, output: 5 } };
    const res = await put(app, prices);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ prices });
    expect(core.getModelPrices()).toEqual(prices);
  });

  it('PUT refuses an invalid table with 400', async () => {
    expect((await put(app, { m: { input: -1, cachedInput: 0, output: 0 } })).status).toBe(400);
  });

  it('a service token may not change prices', async () => {
    const tokenApp = buildApp(core, { auth: { mode: 'token' } });
    const service = core.createApiToken({ label: 'reviewer', isService: true }).token;
    expect((await put(tokenApp, {}, { authorization: `Bearer ${service}` })).status).toBe(403);
    expect(core.getModelPrices()).toEqual(DEFAULT_MODEL_PRICES);
  });
});
