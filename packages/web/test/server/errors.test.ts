import { describe, it, expect } from 'vitest';
import { mapError } from '../../server/errors.js';
import { GitError } from '../../server/git.js';
import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';

describe('mapError', () => {
  it('maps NotFoundError → 404', () => { expect(mapError(new NotFoundError('x')).status).toBe(404); });
  it('maps InvalidTransitionError → 409', () => { expect(mapError(new InvalidTransitionError('x')).status).toBe(409); });
  it('maps ValidationError → 400', () => { expect(mapError(new ValidationError('x')).status).toBe(400); });
  it('maps GitError → 422', () => { expect(mapError(new GitError('x')).status).toBe(422); });
  it('maps unknown → 500', () => { expect(mapError(new Error('x')).status).toBe(500); });

  it.each([
    [new NotFoundError('nope'), 404, 'nope'],
    [new InvalidTransitionError('bad move'), 409, 'bad move'],
    [new ValidationError('bad input'), 400, 'bad input'],
    [new GitError('no repo'), 422, 'no repo'],
    [new Error('secret detail'), 500, 'Internal error'],
  ])('responds with JSON { message } for %s', async (err, status, message) => {
    const res = mapError(err).getResponse();
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual({ message });
  });
});
