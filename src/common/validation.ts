import { HttpStatus } from '@nestjs/common';
import type { ZodType } from 'zod';
import { ApiError } from './api-error';

/** Parses a request body or query with zod; failures become 422 with per-field details. */
export function parseInput<T>(schema: ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input ?? {});
  if (result.success) {
    return result.data;
  }
  throw new ApiError(
    HttpStatus.UNPROCESSABLE_ENTITY,
    'validation_failed',
    'Request validation failed.',
    result.error.issues.map((issue) => ({
      field: issue.path.join('.') || null,
      message: issue.message,
    })),
  );
}
