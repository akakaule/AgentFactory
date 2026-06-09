import { NotFoundError, InvalidTransitionError, ValidationError } from '@agentfactory/core';

export function toToolError(err: unknown) {
  let msg: string;
  if (err instanceof NotFoundError) msg = `Task not found: ${err.message}`;
  else if (err instanceof InvalidTransitionError) msg = `Invalid transition: ${err.message}`;
  else if (err instanceof ValidationError) msg = `Invalid input: ${err.message}`;
  else msg = `Unexpected error: ${(err as Error).message}`;
  return { isError: true as const, content: [{ type: 'text' as const, text: msg }] };
}
