import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { RedisSemaphore } from '../../src/common/redis-semaphore';
import { testPrefix, testRedis } from '../support/redis';

let redis: Redis;
beforeAll(() => {
  redis = testRedis();
});
afterAll(() => redis.quit());

describe('RedisSemaphore', () => {
  it('admits at most `limit` holders and frees a slot on release', async () => {
    const semaphore = new RedisSemaphore(redis);
    const key = testPrefix('sem');
    expect(await semaphore.acquire(key, 'a', 2, 10_000)).toBe(true);
    expect(await semaphore.acquire(key, 'b', 2, 10_000)).toBe(true);
    expect(await semaphore.acquire(key, 'c', 2, 10_000)).toBe(false);
    await semaphore.release(key, 'a');
    expect(await semaphore.acquire(key, 'c', 2, 10_000)).toBe(true);
  });

  it('reclaims slots of crashed holders after their lease', async () => {
    const semaphore = new RedisSemaphore(redis);
    const key = testPrefix('sem');
    expect(await semaphore.acquire(key, 'crashed', 1, 100)).toBe(true);
    expect(await semaphore.acquire(key, 'next', 1, 100)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await semaphore.acquire(key, 'next', 1, 100)).toBe(true);
  });
});
