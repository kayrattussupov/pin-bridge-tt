import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CircuitBreaker, CircuitBreakerOptions } from '../../src/pin/circuit-breaker';
import { PinError } from '../../src/pin/pin.errors';
import { testPrefix, testRedis } from '../support/redis';

let redis: Redis;
beforeAll(() => {
  redis = testRedis();
});
afterAll(() => redis.quit());

function breaker(overrides: Partial<CircuitBreakerOptions> = {}): CircuitBreaker {
  return new CircuitBreaker(redis, {
    keyPrefix: testPrefix('breaker'),
    windowMs: 10_000,
    bucketMs: 1_000,
    minRequests: 4,
    failureRatio: 0.5,
    openMs: 150,
    probeTimeoutMs: 1_000,
    ...overrides,
  });
}

async function fail(cb: CircuitBreaker, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await cb.recordFailure(await cb.beforeRequest('test'));
  }
}

async function succeed(cb: CircuitBreaker, times: number): Promise<void> {
  for (let i = 0; i < times; i++) {
    await cb.recordSuccess(await cb.beforeRequest('test'));
  }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('CircuitBreaker', () => {
  it('stays closed below the minimum number of requests', async () => {
    const cb = breaker();
    await fail(cb, 3);
    expect(await cb.state()).toBe('closed');
  });

  it('stays closed while the failure ratio is below the threshold', async () => {
    const cb = breaker();
    await succeed(cb, 6);
    await fail(cb, 5);
    expect(await cb.state()).toBe('closed');
  });

  it('opens on too many failures and refuses calls without sending them', async () => {
    const cb = breaker();
    await succeed(cb, 1);
    await fail(cb, 3);
    expect(await cb.state()).toBe('open');
    const refusal = await cb.beforeRequest('items.create').catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(PinError);
    expect(refusal).toMatchObject({ kind: 'breaker_open', notSent: true });
    expect((refusal as PinError).retryAfterMs).toBeGreaterThan(0);
  });

  it('lets exactly one probe through when half-open, and closes on its success', async () => {
    const cb = breaker();
    await fail(cb, 4);
    await sleep(200);
    expect(await cb.state()).toBe('half_open');

    const probe = await cb.beforeRequest('test');
    expect(probe.probe).toBe(true);
    await expect(cb.beforeRequest('test')).rejects.toMatchObject({ kind: 'breaker_open' });

    await cb.recordSuccess(probe);
    expect(await cb.state()).toBe('closed');
    // The old failures are forgotten after recovery.
    await fail(cb, 1);
    expect(await cb.state()).toBe('closed');
  });

  it('re-opens when the probe fails', async () => {
    const cb = breaker();
    await fail(cb, 4);
    await sleep(200);
    const probe = await cb.beforeRequest('test');
    await cb.recordFailure(probe);
    expect(await cb.state()).toBe('open');
  });

  it('is shared by every instance using the same prefix (api and workers)', async () => {
    const keyPrefix = testPrefix('shared');
    const a = breaker({ keyPrefix });
    const b = breaker({ keyPrefix });
    await fail(a, 4);
    await expect(b.beforeRequest('test')).rejects.toMatchObject({ kind: 'breaker_open' });
  });
});
