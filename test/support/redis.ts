import { randomUUID } from 'node:crypto';
import { Redis } from 'ioredis';

/** Tests that need Redis use REDIS_URL (CI service) or a local default. */
export function testRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', { maxRetriesPerRequest: 1 });
}

/** Unique key prefix so parallel test files never share breaker or limiter state. */
export function testPrefix(name: string): string {
  return `pin-bridge-test:${name}:${randomUUID()}`;
}
