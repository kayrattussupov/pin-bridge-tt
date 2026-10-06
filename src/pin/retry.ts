import { PinError } from './pin.errors';

/** Which failures the client itself may resend. Anything not resent is left to the job queue. */
export type RetryPolicy =
  /** Idempotent call (GET, validate, upload before any response): resend any retryable failure. */
  | 'safe'
  /** Non-idempotent call (create, toggle, remove, SMS): resend only if the request never left. */
  | 'none';

export interface BackoffOptions {
  baseMs: number;
  maxMs: number;
  maxAttempts: number;
}

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 500, maxMs: 8_000, maxAttempts: 3 };

/** Exponential backoff with full jitter: a random delay in [0, min(max, base * 2^(attempt-1))]. */
export function backoffDelayMs(
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  const ceiling = Math.min(options.maxMs, options.baseMs * 2 ** (attempt - 1));
  return Math.floor(random() * ceiling);
}

export function shouldRetry(
  error: PinError,
  policy: RetryPolicy,
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
): boolean {
  if (attempt >= options.maxAttempts || !error.retryable) {
    return false;
  }
  // Waiting on our own breaker/limiter inside one call would only stack delays; the queue retries.
  if (error.kind === 'breaker_open' || error.kind === 'local_rate_limit') {
    return false;
  }
  return policy === 'safe' || error.notSent;
}

/** Retry-After from Pin wins (capped), otherwise jittered backoff. */
export function retryDelayMs(
  error: PinError,
  attempt: number,
  options: BackoffOptions = DEFAULT_BACKOFF,
  random: () => number = Math.random,
): number {
  if (error.retryAfterMs !== undefined) {
    return Math.min(error.retryAfterMs, options.maxMs);
  }
  return backoffDelayMs(attempt, options, random);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));
