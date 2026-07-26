import { zValidator } from '@hono/zod-validator';
import { ValidationError } from '@agentfactory/core';
import type { z } from 'zod';

/**
 * zValidator with a hook that re-throws schema rejections through the app's error mapping.
 * Without it, @hono/zod-validator responds directly with the raw ZodError JSON (no `message`
 * key, never touching onError/mapError), so clients rendered the literal status code ("400")
 * instead of the schema's carefully worded message. Message shape matches core's parse():
 * issue messages joined with '; '.
 */
export function validated<T extends z.ZodType, Target extends 'json' | 'query'>(target: Target, schema: T) {
  return zValidator(target, schema, (result) => {
    if (!result.success) throw new ValidationError(result.error.issues.map((i) => i.message).join('; '));
  });
}
