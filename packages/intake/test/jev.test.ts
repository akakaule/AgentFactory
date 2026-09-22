import { expect, it, vi } from 'vitest';
import { JevTaskIntakeDecisionProvider } from '../src/providers/jev.js';

it('sends typed questions and maps documented Noul and Choice answers', async () => {
  const fetchImpl = vi.fn().mockResolvedValue(Response.json({
    model: 'jev-1.13.0', usage: { input_tokens: 100, output_tokens: 20 },
    answers: {
      outcomeClear: { type: 'noul', noul: 0.9 }, scopeBounded: { type: 'noul', noul: 0.8 }, verifiable: { type: 'noul', noul: 0.7 },
      complexity: { type: 'choice', choice: 'small', confidence: 0.8, probabilities: { trivial: 0, small: 1, medium: 0, large: 0, architectural: 0 } },
      risk: { type: 'choice', choice: 'low', confidence: 0.9, probabilities: { low: 1, medium: 0, high: 0, critical: 0 } },
    },
  }));
  const provider = new JevTaskIntakeDecisionProvider({ endpoint: 'https://example.test', apiKey: 'test', model: 'jev-1.13.0', fetchImpl });
  const result = await provider.assess({ key: 'TEST-1', title: 'Synthetic', spec: 'Test', acceptanceCriteria: 'Test passes', stage: 'implementation', plan: null, links: [], attachmentCount: 0, workspacePolicy: null }, new AbortController().signal);
  const request = JSON.parse(fetchImpl.mock.calls[0]![1].body);
  expect(request.questions.outcomeClear).toMatchObject({ type: 'noul', instructions: expect.any(String) });
  expect(Object.keys(request.questions.complexity.criteria)).toEqual(['trivial', 'small', 'medium', 'large', 'architectural']);
  expect(request.questions.risk.type).toBe('choice');
  expect(result.decisions.readiness.probability).toBe(0.7);
  expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 20 });
});
