import { describe, it, expect } from 'vitest';
import { parseCliMetrics, hasMetrics, parsePermissionDenials } from '../src/metrics.js';

describe('parseCliMetrics', () => {
  it('reads cost, tokens, model, and duration from a result envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 12345,
      total_cost_usd: 0.4231,
      usage: { input_tokens: 1000, output_tokens: 250 },
      modelUsage: { 'claude-opus-4-8': { inputTokens: 1000, outputTokens: 250 } },
    });
    const m = parseCliMetrics(stdout);
    expect(m.costUsd).toBe(0.4231);
    expect(m.tokensIn).toBe(1000);
    expect(m.tokensOut).toBe(250);
    expect(m.model).toBe('claude-opus-4-8');
    expect(m.durationMs).toBe(12345);
  });

  it('sums plain + cache input tokens', () => {
    const m = parseCliMetrics(
      JSON.stringify({
        usage: { input_tokens: 100, cache_creation_input_tokens: 30, cache_read_input_tokens: 70, output_tokens: 9 },
      }),
    );
    expect(m.tokensIn).toBe(200);
    expect(m.tokensOut).toBe(9);
  });

  it('reads a top-level model field', () => {
    const m = parseCliMetrics(JSON.stringify({ model: 'claude-sonnet-4-6', total_cost_usd: 0.1 }));
    expect(m.model).toBe('claude-sonnet-4-6');
  });

  it('tolerates leading log noise before the JSON', () => {
    const stdout = 'some stderr leaked here\n{"total_cost_usd":0.5,"usage":{"output_tokens":3}}\n';
    const m = parseCliMetrics(stdout);
    expect(m.costUsd).toBe(0.5);
    expect(m.tokensOut).toBe(3);
  });

  it('returns {} for unparseable output', () => {
    expect(parseCliMetrics('not json at all')).toEqual({});
    expect(parseCliMetrics('')).toEqual({});
  });

  it('hasMetrics distinguishes empty from populated', () => {
    expect(hasMetrics({})).toBe(false);
    expect(hasMetrics({ durationMs: 10 })).toBe(false); // duration alone is not a billable metric
    expect(hasMetrics({ costUsd: 0.1 })).toBe(true);
    expect(hasMetrics({ tokensOut: 5 })).toBe(true);
  });
});

describe('parsePermissionDenials', () => {
  it('reads denied tool names from the result envelope', () => {
    const stdout = JSON.stringify({
      type: 'result',
      subtype: 'success',
      permission_denials: [
        { tool_name: 'mcp__agentfactory__get_next_task', tool_use_id: 'toolu_01x', tool_input: {} },
        { tool_name: 'Bash', tool_use_id: 'toolu_02x', tool_input: {} },
      ],
    });
    expect(parsePermissionDenials(stdout)).toEqual(['mcp__agentfactory__get_next_task', 'Bash']);
  });

  it('returns [] when there are no denials, the field is missing, or output is unparseable', () => {
    expect(parsePermissionDenials(JSON.stringify({ type: 'result', permission_denials: [] }))).toEqual([]);
    expect(parsePermissionDenials(JSON.stringify({ type: 'result' }))).toEqual([]);
    expect(parsePermissionDenials('not json')).toEqual([]);
    expect(parsePermissionDenials('')).toEqual([]);
  });
});
