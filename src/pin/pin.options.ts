import type { Env } from '../config/env';
import type { PinClientOptions } from './pin.client';
import { DEFAULT_BACKOFF } from './retry';

const KEY_PREFIX = 'pin-bridge:pin';

export function pinClientOptionsFromEnv(env: Env, userAgent: string): PinClientOptions {
  return {
    transport: {
      baseUrl: env.PIN_BASE_URL,
      proxyUrl: env.PIN_HTTPS_PROXY,
      connectTimeoutMs: env.PIN_CONNECT_TIMEOUT_MS,
      userAgent,
      maxResponseBytes: 10 * 1024 * 1024,
    },
    requestTimeoutMs: env.PIN_REQUEST_TIMEOUT_MS,
    uploadTimeoutMs: env.PIN_UPLOAD_TIMEOUT_MS,
    breaker: {
      keyPrefix: `${KEY_PREFIX}:breaker`,
      windowMs: env.PIN_BREAKER_WINDOW_MS,
      bucketMs: Math.max(1_000, Math.floor(env.PIN_BREAKER_WINDOW_MS / 6)),
      minRequests: env.PIN_BREAKER_MIN_REQUESTS,
      failureRatio: env.PIN_BREAKER_FAILURE_RATIO,
      openMs: env.PIN_BREAKER_OPEN_MS,
      probeTimeoutMs: env.PIN_UPLOAD_TIMEOUT_MS,
    },
    rateLimit: {
      key: `${KEY_PREFIX}:rate-limit`,
      ratePerSecond: env.PIN_RATE_LIMIT_RPS,
      burst: env.PIN_RATE_LIMIT_BURST,
      maxWaitMs: env.PIN_RATE_LIMIT_MAX_WAIT_MS,
    },
    backoff: DEFAULT_BACKOFF,
  };
}
