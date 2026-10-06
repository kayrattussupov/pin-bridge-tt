import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RateLimiter } from '../../src/pin/rate-limiter';
import { testPrefix, testRedis } from '../support/redis';

let redis: Redis;
beforeAll(() => {
  redis = testRedis();
});
afterAll(() => redis.quit());

describe('RateLimiter', () => {
  it('allows a burst immediately, then paces calls at the configured rate', async () => {
    const limiter = new RateLimiter(redis, {
      key: testPrefix('rl'),
      ratePerSecond: 20,
      burst: 3,
      maxWaitMs: 5_000,
    });
    const started = Date.now();
    for (let i = 0; i < 3; i++) {
      await limiter.acquire('test');
    }
    expect(Date.now() - started).toBeLessThan(100);

    for (let i = 0; i < 4; i++) {
      await limiter.acquire('test');
    }
    // 4 more tokens at 20/s need ~200 ms.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
  });

  it('gives up with local_rate_limit instead of waiting too long', async () => {
    const limiter = new RateLimiter(redis, {
      key: testPrefix('rl'),
      ratePerSecond: 0.5,
      burst: 1,
      maxWaitMs: 100,
    });
    await limiter.acquire('test');
    await expect(limiter.acquire('items.create')).rejects.toMatchObject({
      kind: 'local_rate_limit',
      notSent: true,
    });
  });

  it('shares one budget between instances', async () => {
    const key = testPrefix('rl');
    const options = { key, ratePerSecond: 0.5, burst: 1, maxWaitMs: 50 };
    await new RateLimiter(redis, options).acquire('test');
    await expect(new RateLimiter(redis, options).acquire('test')).rejects.toMatchObject({
      kind: 'local_rate_limit',
    });
  });
});
