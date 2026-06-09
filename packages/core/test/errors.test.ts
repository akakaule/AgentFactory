import { describe, it, expect } from 'vitest';
import { NotFoundError, InvalidTransitionError, ValidationError } from '../src/errors.js';

describe('error classes', () => {
  it('carry name + message and are instanceof Error', () => {
    for (const E of [NotFoundError, InvalidTransitionError, ValidationError]) {
      const e = new E('msg');
      expect(e).toBeInstanceOf(Error);
      expect(e.name).toBe(E.name);
      expect(e.message).toBe('msg');
    }
  });
});
