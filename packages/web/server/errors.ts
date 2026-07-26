import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';
import { GitError } from './git.js';

const jsonError = (status: ContentfulStatusCode, message: string) =>
  new HTTPException(status, { res: Response.json({ message }, { status }) });

export function mapError(err: unknown): HTTPException {
  if (err instanceof NotFoundError) return jsonError(404, err.message);
  if (err instanceof InvalidTransitionError) return jsonError(409, err.message);
  if (err instanceof ValidationError) return jsonError(400, err.message);
  if (err instanceof GitError) return jsonError(422, err.message);
  // Unknown = a genuine bug, and this server usually runs unattended — without this line
  // a crashing op is completely invisible (the client only ever sees 'Internal error').
  console.error('[api] unhandled error:', err);
  return jsonError(500, 'Internal error');
}
