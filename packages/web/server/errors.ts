import { HTTPException } from 'hono/http-exception';
import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';

export function mapError(err: unknown): HTTPException {
  if (err instanceof NotFoundError) return new HTTPException(404, { message: err.message });
  if (err instanceof InvalidTransitionError) return new HTTPException(409, { message: err.message });
  if (err instanceof ValidationError) return new HTTPException(400, { message: err.message });
  return new HTTPException(500, { message: 'Internal error' });
}
