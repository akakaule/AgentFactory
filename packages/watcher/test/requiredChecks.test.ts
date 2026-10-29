import { describe, it, expect } from 'vitest';
import { evaluateRequiredChecks } from '../src/requiredChecks.js';

describe('evaluateRequiredChecks', () => {
  it('fails when a required check failed', () => {
    expect(evaluateRequiredChecks(['build', 'test'], [{ name: 'build', state: 'passing' }, { name: 'test', state: 'failing' }]))
      .toEqual({ checks: { build: 'passed', test: 'failed' }, verdict: 'failed' });
  });

  it('waits when a required check is missing', () => {
    expect(evaluateRequiredChecks(['build', 'test'], [{ name: 'build', state: 'passing' }]))
      .toEqual({ checks: { build: 'passed', test: 'missing' }, verdict: 'waiting' });
  });

  it('waits while a required check is pending', () => {
    expect(evaluateRequiredChecks(['build'], [{ name: 'build', state: 'pending' }]))
      .toEqual({ checks: { build: 'pending' }, verdict: 'waiting' });
  });

  it('passes when every required check passed, ignoring checks outside the list', () => {
    expect(evaluateRequiredChecks(['build'], [{ name: 'build', state: 'passing' }, { name: 'lint', state: 'failing' }]))
      .toEqual({ checks: { build: 'passed' }, verdict: 'passed' });
  });

  it('judges a name reported more than once by its worst report', () => {
    expect(evaluateRequiredChecks(['build'], [{ name: 'build', state: 'passing' }, { name: 'build', state: 'failing' }]).checks.build).toBe('failed');
    expect(evaluateRequiredChecks(['build'], [{ name: 'build', state: 'passing' }, { name: 'build', state: 'pending' }]).checks.build).toBe('pending');
  });
});
