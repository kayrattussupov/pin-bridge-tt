import type { Redis } from 'ioredis';
import { TokenBucket } from '../common/token-bucket';
import { PinError } from './pin.errors';
import { sleep } from './retry';

export interface RateLimiterOptions {
  key: string;
  ratePerSecond: number;
  burst: number;
  /** Longest a caller waits for a token before giving up with `local_rate_limit`. */
  maxWaitMs: number;
}

/** Global outgoing budget for Pin, shared by every process through Redis. */
export class RateLimiter {
  private readonly bucket: TokenBucket;

  constructor(
    redis: Redis,
    private readonly options: RateLimiterOptions,
  ) {
    this.bucket = new TokenBucket(redis);
  }

  async acquire(endpoint: string): Promise<void> {
    const deadline = Date.now() + this.options.maxWaitMs;
    for (;;) {
      const wait = await this.bucket.take(
        this.options.key,
        this.options.ratePerSecond,
        this.options.burst,
      );
      if (wait <= 0) {
        return;
      }
      if (Date.now() + wait > deadline) {
        throw new PinError({
          kind: 'local_rate_limit',
          endpoint,
          notSent: true,
          retryAfterMs: wait,
        });
      }
      await sleep(wait);
    }
  }
}
