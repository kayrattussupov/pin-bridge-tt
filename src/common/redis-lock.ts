import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

// Deletes the lock only if we still own it, so an expired lock taken over by someone else
// is never released by the previous holder.
const RELEASE_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Runs `fn` while holding a Redis lock. Returns `{ acquired: false }` immediately if the lock is
 * held elsewhere. `ttlMs` must exceed the longest expected run (it guards against crashes).
 */
export async function withRedisLock<T>(
  redis: Redis,
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<{ acquired: true; value: T } | { acquired: false }> {
  const token = randomUUID();
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') {
    return { acquired: false };
  }
  try {
    return { acquired: true, value: await fn() };
  } finally {
    await redis.eval(RELEASE_SCRIPT, 1, key, token);
  }
}
