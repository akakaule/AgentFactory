import { describe, it, expect } from 'vitest';
import { toToolError } from '../src/errors.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';

describe('toToolError', () => {
  it('maps NotFoundError', () => {
    const r = toToolError(new NotFoundError('AF-9 missing'));
    expect(r.isError).toBe(true);
    expect(r.content[0]!.text).toContain('Task not found');
    expect(r.content[0]!.text).toContain('AF-9 missing');
  });
  it('maps InvalidTransitionError', () => {
    expect(toToolError(new InvalidTransitionError('done -> queued')).content[0]!.text).toContain('Invalid transition');
  });
  it('maps ValidationError', () => {
    expect(toToolError(new ValidationError('empty title')).content[0]!.text).toContain('Invalid input');
  });
  it('maps unknown errors', () => {
    const r = toToolError(new Error('boom'));
    expect(r.content[0]!.text).toContain('Unexpected error');
    expect(r.content[0]!.text).toContain('boom');
  });
});
