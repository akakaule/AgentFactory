import { describe, it, expect } from 'vitest';
import { mapError } from '../../server/errors.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';

describe('mapError', () => {
  it('maps NotFoundError → 404', () => { expect(mapError(new NotFoundError('x')).status).toBe(404); });
  it('maps InvalidTransitionError → 409', () => { expect(mapError(new InvalidTransitionError('x')).status).toBe(409); });
  it('maps ValidationError → 400', () => { expect(mapError(new ValidationError('x')).status).toBe(400); });
  it('maps unknown → 500', () => { expect(mapError(new Error('x')).status).toBe(500); });
});
