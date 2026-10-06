import { HttpException, HttpStatus } from '@nestjs/common';

export type ApiErrorCode =
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'validation_failed'
  | 'rate_limited'
  | 'payload_too_large'
  | 'invalid_phone'
  | 'invalid_code'
  | 'sms_rate_limited'
  | 'sms_code_attempts_exceeded'
  | 'connection_busy'
  | 'connection_not_active'
  | 'pin_rejected'
  | 'pin_unavailable'
  | 'pin_bad_response'
  | 'dictionary_unavailable'
  | 'idempotency_key_reused'
  | 'invalid_listing'
  | 'invalid_webhook_url'
  | 'invalid_invite'
  | 'domain_not_verified'
  | 'agency_exists'
  | 'internal';

/** Error with a stable machine-readable code for agencies. Rendered by ApiExceptionFilter. */
export class ApiError extends HttpException {
  constructor(
    status: HttpStatus,
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers: Record<string, string> = {},
  ) {
    super(message, status);
  }

  static unauthorized(message = 'Invalid or missing credentials.'): ApiError {
    return new ApiError(HttpStatus.UNAUTHORIZED, 'unauthorized', message);
  }

  /** Same answer for unknown, expired, revoked and used codes, so codes cannot be probed. */
  static invalidInvite(): ApiError {
    return new ApiError(
      HttpStatus.UNAUTHORIZED,
      'invalid_invite',
      'The invite code is invalid, expired or already used.',
    );
  }

  static forbidden(message: string): ApiError {
    return new ApiError(HttpStatus.FORBIDDEN, 'forbidden', message);
  }

  static notFound(what: string): ApiError {
    return new ApiError(HttpStatus.NOT_FOUND, 'not_found', `${what} not found.`);
  }

  static rateLimited(retryAfterMs: number): ApiError {
    const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
    return new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      'rate_limited',
      'Too many requests for this API key.',
      { retry_after_seconds: seconds },
      { 'retry-after': String(seconds) },
    );
  }

  /** 429 with Retry-After for a named limit other than the per-key request budget. */
  static tooManyRequests(code: ApiErrorCode, message: string, retryAfterSeconds: number): ApiError {
    const seconds = Math.max(1, Math.ceil(retryAfterSeconds));
    return new ApiError(
      HttpStatus.TOO_MANY_REQUESTS,
      code,
      message,
      { retry_after_seconds: seconds },
      { 'retry-after': String(seconds) },
    );
  }
}
