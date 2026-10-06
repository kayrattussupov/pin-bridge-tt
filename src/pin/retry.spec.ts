import { describe, expect, it } from 'vitest';
import { PinError, PinErrorKind } from './pin.errors';
import { backoffDelayMs, retryDelayMs, shouldRetry } from './retry';

const options = { baseMs: 100, maxMs: 1_000, maxAttempts: 3 };
const error = (
  kind: PinErrorKind,
  extra: Partial<ConstructorParameters<typeof PinError>[0]> = {},
) => new PinError({ kind, endpoint: 'test', ...extra });

describe('backoffDelayMs', () => {
  it('grows exponentially up to the cap', () => {
    const max = () => 0.999_999;
    expect(backoffDelayMs(1, options, max)).toBe(99);
    expect(backoffDelayMs(2, options, max)).toBe(199);
    expect(backoffDelayMs(3, options, max)).toBe(399);
    expect(backoffDelayMs(10, options, max)).toBe(999);
  });

  it('uses full jitter', () => {
    expect(backoffDelayMs(3, options, () => 0)).toBe(0);
  });
});

describe('retryDelayMs', () => {
  it('prefers Retry-After, capped at maxMs', () => {
    expect(retryDelayMs(error('rate_limited', { retryAfterMs: 300 }), 1, options)).toBe(300);
    expect(retryDelayMs(error('rate_limited', { retryAfterMs: 60_000 }), 1, options)).toBe(1_000);
  });
});

describe('shouldRetry', () => {
  it('resends retryable failures of safe calls', () => {
    expect(shouldRetry(error('server'), 'safe', 1, options)).toBe(true);
    expect(shouldRetry(error('timeout'), 'safe', 2, options)).toBe(true);
  });

  it('stops at maxAttempts', () => {
    expect(shouldRetry(error('server'), 'safe', 3, options)).toBe(false);
  });

  it('never resends validation or auth failures', () => {
    for (const kind of ['validation', 'unauthorized', 'cloudflare_blocked', 'not_found'] as const) {
      expect(shouldRetry(error(kind), 'safe', 1, options)).toBe(false);
    }
  });

  it('resends a non-idempotent call only when it provably was not sent', () => {
    expect(shouldRetry(error('server'), 'none', 1, options)).toBe(false);
    expect(shouldRetry(error('timeout', { outcomeUnknown: true }), 'none', 1, options)).toBe(false);
    expect(shouldRetry(error('network', { notSent: true }), 'none', 1, options)).toBe(true);
  });

  it('leaves breaker and local rate limit waits to the queue', () => {
    expect(shouldRetry(error('breaker_open', { notSent: true }), 'safe', 1, options)).toBe(false);
    expect(shouldRetry(error('local_rate_limit', { notSent: true }), 'safe', 1, options)).toBe(
      false,
    );
  });
});
